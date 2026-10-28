import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ErrorObject } from 'ajv';
import type { Db } from '../db/index.ts';
import { EXPORT_SCHEMA_VERSION } from '../../shared/app.ts';
import { jobDetail, loadJobRows } from '../jobs/read.ts';
import { activeWeightProfile } from '../score/profile.ts';

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.v1.json');
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
const ajv = new Ajv({ allErrors: true, strict: false });
const validateFn = ajv.compile(schema);

export interface ExportDoc {
  schema_version: number;
  generated_at: string;
  weights_version: string;
  jobs: Array<Record<string, unknown>>;
}

// Patterns that must never appear in an export: OAuth and API tokens, cookies, key
// material, and passwords. The scan reports rule names only, never the matched text.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'google access token', re: /\bya29\.[A-Za-z0-9._-]{8,}/ },
  { name: 'google refresh token', re: /\b1\/\/[A-Za-z0-9_-]{20,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/ },
  { name: 'cookie header', re: /\b(Set-Cookie|Cookie):\s/i },
  { name: 'credential field', re: /"(refresh_token|access_token|client_secret|password|keyring_password)"\s*:/i },
  { name: 'session identifier', re: /\bsession_?id=/i },
];

export class ExportError extends Error {}

export function buildExport(db: Db, now: Date): ExportDoc {
  const profile = activeWeightProfile(db);
  const jobs: Array<Record<string, unknown>> = [];
  for (const row of loadJobRows(db)) {
    const d = jobDetail(db, row.id);
    if (!d) continue;
    const comp = d.pay as { min: number; max: number; period: string | null; annualized: boolean } | null;
    jobs.push({
      id: d.id,
      title: d.title,
      company: d.company,
      location: d.location,
      arrangement: d.arrangement,
      compensation: comp ? { min: comp.min, max: comp.max, currency: 'USD', period: comp.period, annualized: comp.annualized } : null,
      posted_at: d.posted_at,
      first_seen: d.first_seen,
      canonical_url: d.canonical_url,
      sources: (d.sources as Array<Record<string, unknown>>).map((s) => ({
        provider: 'linkedin',
        source_id: /\/jobs\/view\/(\d+)/.exec(String(s.url))?.[1] ?? String(s.id),
        url: String(s.url),
        message_id: String(s.message_id),
      })),
      score: d.score,
      confidence: d.confidence,
      flags: d.flags,
      factors: (d.factors as Array<Record<string, unknown>>).map((f) => ({
        name: String(f.factor),
        points: Number(f.points),
        max: Number(f.max),
        evidence: f.evidence_excerpt ? [String(f.evidence_excerpt).slice(0, 200)] : [],
        confidence: f.confidence ?? null,
      })),
      stage: d.stage ?? 'inbox',
      status: d.applied ? (d.applied as { status: string }).status : null,
      verdict: d.verdict,
      reason_tags: d.reason_tags,
      blocked: d.blocked
        ? { at: (d.blocked as { at: string }).at, reason: (d.blocked as { reason: string }).reason, scope: 'job' }
        : d.rule_blocked
          ? { at: now.toISOString(), reason: 'Blocked by rule', scope: 'rule' }
          : null,
    });
  }
  jobs.sort((a, b) => (Number(b.score ?? -1) - Number(a.score ?? -1)) || Number(a.id) - Number(b.id));
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    weights_version: `v${profile.version}`,
    jobs,
  };
}

export function validateExport(doc: unknown): { ok: true } | { ok: false; errors: string[] } {
  if (validateFn(doc)) return { ok: true };
  const errors = (validateFn.errors ?? []).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim()).slice(0, 10);
  return { ok: false, errors };
}

// Returns the names of any secret rules that match. Empty means clean.
export function scanForSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

export function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// Builds, validates, and scans an export. Throws if validation fails or a secret pattern
// is found. The caller gets the serialized text and its checksum.
export function prepareExport(db: Db, now: Date): { text: string; checksum: string; jobs: number } {
  const doc = buildExport(db, now);
  const check = validateExport(doc);
  if (!check.ok) throw new ExportError(`The export did not match schema version 1: ${check.errors.join('; ')}`);
  const text = JSON.stringify(doc, null, 2) + '\n';
  const hits = scanForSecrets(text);
  if (hits.length > 0) throw new ExportError(`The export was blocked by the secret scan (${hits.join(', ')})`);
  return { text, checksum: checksum(text), jobs: doc.jobs.length };
}
