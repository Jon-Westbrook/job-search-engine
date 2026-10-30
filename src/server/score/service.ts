import type { Db } from '../db/index.ts';
import type { Logger } from '../log.ts';
import { directTierFor } from '../contacts.ts';
import { findApplicationMatch } from '../applications.ts';
import { weakMatchesFor } from '../grouping.ts';
import { normalizeCompany } from '../normalize/keys.ts';
import { buildBatchPrompt, BATCH_SIZE, validateBatch, type BatchItemResult } from './extract.ts';
import { PROMPT_VERSION } from './extract.ts';
import type { CodexRunner } from './codex.ts';
import { activeWeightProfile } from './profile.ts';
import { scoreListing, type Extraction, type ScoreOutput } from './rules.ts';

export interface ScoringDeps {
  db: Db;
  codex: CodexRunner;
  logger: Logger;
  now: () => Date;
  aliases: Record<string, string>;
  profile: {
    gmail_account?: string;
    resume_summary?: string;
    tn_hostile_agencies?: string[];
    targets?: { accepted_geography?: string[] };
  };
}

export type ScoreOutcome =
  | { status: 'scored'; jobId: number; scoreRunId: number; mode: 'ai' | 'rules_only'; score: number; confidence: string }
  | { status: 'paused'; jobId: number; error: string };

interface JobRow {
  id: number;
  canonical_url: string;
  title: string;
  company: string | null;
  location: string | null;
  arrangement: 'onsite' | 'hybrid' | 'remote' | null;
  company_key: string | null;
  title_key: string | null;
  posted_at: string | null;
  comp_min: number | null;
  comp_max: number | null;
  comp_period: string | null;
  comp_currency: string | null;
  comp_annualized: number | null;
  rule_blocked: number;
  rule_overridden_at: string | null;
}

// Scores one job. The AI extracts factor values. The deterministic scorer computes the
// score. If the provider fails, scoring pauses and nothing is written for this job.
export const BATCH_CONCURRENCY = 3;

// The AI answer for one job: validated factor values, or the reason they could not be used.
export type AiResult = { extraction: Extraction } | { invalid: string };

function promptRow(db: Db, jobId: number) {
  const job = db.prepare('SELECT title, company, location, arrangement FROM jobs WHERE id = ?').get(jobId) as
    | { title: string; company: string | null; location: string | null; arrangement: string | null }
    | undefined;
  if (!job) return null;
  const description = (db.prepare('SELECT text FROM job_descriptions WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(jobId) as { text: string } | undefined)?.text ?? null;
  return { jobId, title: job.title, company: job.company, location: job.location, arrangement: job.arrangement, description };
}

// One call for several jobs. A provider failure returns an error, which pauses scoring. Output
// that breaks the schema, or has no entry for a job, gives only that job rules-only scoring.
export async function extractBatch(
  deps: ScoringDeps,
  jobIds: number[],
): Promise<{ ok: true; results: Map<number, AiResult> } | { ok: false; error: string }> {
  const items = jobIds.map((id) => promptRow(deps.db, id)).filter((row): row is NonNullable<typeof row> => row !== null);
  const prompt = buildBatchPrompt(deps.profile.resume_summary ?? '', items);
  const call = await deps.codex.extractBatch(prompt);
  if (!call.ok) {
    deps.logger.warn('ai extraction failed; scoring paused', { jobs: jobIds.length, error: call.error });
    return { ok: false, error: call.error };
  }
  const checked = validateBatch(call.json);
  const results = new Map<number, AiResult>();
  for (const id of jobIds) {
    const invalid = { invalid: 'AI output did not match the schema, so this score uses rules only' };
    if (!checked.ok) {
      results.set(id, invalid);
      continue;
    }
    const item: BatchItemResult | undefined = checked.items.get(id);
    if (!item) results.set(id, { invalid: 'AI returned no entry for this job, so this score uses rules only' });
    else if (item.ok) results.set(id, { extraction: item.value });
    else results.set(id, invalid);
  }
  if (!checked.ok) deps.logger.warn('ai batch output rejected by schema', { errors: checked.errors });
  return { ok: true, results };
}

// Scores one job. The batch result is passed in by scoreNeeded. A bare call (for example a
// rescore after a pasted description) runs a batch of one.
export async function scoreJob(deps: ScoringDeps, jobId: number, aiAvailable: boolean, preset?: AiResult | null): Promise<ScoreOutcome> {
  const { db } = deps;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as unknown as JobRow | undefined;
  if (!job) return { status: 'paused', jobId, error: 'Job not found' };

  const postings = db
    .prepare(
      `SELECT sp.* FROM job_sources js JOIN source_postings sp ON sp.id = js.posting_id
       WHERE js.job_id = ? AND js.split_at IS NULL ORDER BY sp.id`,
    )
    .all(jobId) as Array<{ easy_apply: number | null; connection_hint: string; posted_at: string | null }>;
  const hint = { connections: 0, companyAlumni: 0, schoolAlumni: 0 };
  let easyApply = false;
  for (const p of postings) {
    easyApply = easyApply || p.easy_apply === 1;
    const h = JSON.parse(p.connection_hint || '{}') as { connections?: number; companyAlumni?: number; schoolAlumni?: number };
    hint.connections = Math.max(hint.connections, h.connections ?? 0);
    hint.companyAlumni = Math.max(hint.companyAlumni, h.companyAlumni ?? 0);
    hint.schoolAlumni = Math.max(hint.schoolAlumni, h.schoolAlumni ?? 0);
  }

  const description = (db.prepare('SELECT text FROM job_descriptions WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(jobId) as { text: string } | undefined)?.text ?? null;
  const profile = activeWeightProfile(db);
  const acceptedGeography = deps.profile.targets?.accepted_geography ?? [];
  const tnHostileAgencies = (deps.profile.tn_hostile_agencies ?? []).map((a) => normalizeCompany(a, deps.aliases) ?? a.toLowerCase());
  const resume = deps.profile.resume_summary ?? '';
  const directTier = directTierFor(db, job.company_key, hint);
  const match = findApplicationMatch(db, { id: job.id, canonical_url: job.canonical_url, company_key: job.company_key, title_key: job.title_key });
  const weak = weakMatchesFor(db, jobId).length > 0;

  // AI extraction: the batch result from scoreNeeded, or a batch of one for a bare call.
  let extraction: Extraction | null = null;
  let extractionFlag: string | null = null;
  const tokens = { in: null as number | null, out: null as number | null };
  let ai: AiResult | null = preset ?? null;
  if (preset === undefined && aiAvailable) {
    const batch = await extractBatch(deps, [jobId]);
    if (!batch.ok) return { status: 'paused', jobId, error: batch.error };
    ai = batch.results.get(jobId) ?? null;
  }
  if (ai && 'extraction' in ai) extraction = ai.extraction;
  if (ai && 'invalid' in ai) extractionFlag = ai.invalid;

  const postedAt = job.posted_at;
  const output: ScoreOutput = scoreListing({
    now: deps.now(),
    weights: profile.weights,
    title: job.title,
    company: job.company,
    location: job.location,
    arrangement: job.arrangement,
    postedAt,
    pay: job.comp_min !== null && job.comp_max !== null && job.comp_currency
      ? { min: job.comp_min, max: job.comp_max, currency: job.comp_currency, annualized: job.comp_annualized === 1 }
      : null,
    easyApply,
    directTier,
    description,
    resumeText: resume,
    extraSources: [],
    extraction,
    acceptedGeography,
    tnHostileAgencies,
    companyKey: job.company_key,
    alreadyApplied: Boolean(match),
    possibleDuplicate: weak,
  });
  if (extractionFlag) output.flags.push(extractionFlag);

  const nowIso = deps.now().toISOString();
  const run = db
    .prepare(
      `INSERT INTO score_runs (job_id, weight_profile_id, mode, prompt_version, extractor_model, reasoning_effort, score, confidence,
         rule_blocked, flags, missing, extraction, tokens_in, tokens_out, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobId,
      profile.id,
      output.mode,
      output.mode === 'ai' ? PROMPT_VERSION : null,
      output.mode === 'ai' ? deps.codex.model : null,
      output.mode === 'ai' ? deps.codex.reasoningEffort : null,
      output.score,
      output.confidence,
      output.ruleBlocked ? 1 : 0,
      JSON.stringify(output.flags),
      JSON.stringify(output.missing),
      extraction ? JSON.stringify(extraction) : null,
      tokens.in,
      tokens.out,
      nowIso,
    );
  const scoreRunId = Number(run.lastInsertRowid);
  const insertFactor = db.prepare(
    `INSERT INTO score_factors (score_run_id, factor, ai_value, points, max, evidence_excerpt, source_field, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const f of [...output.factors, ...output.penalties]) {
    insertFactor.run(scoreRunId, f.factor, f.aiValue, f.points, f.max, f.evidence[0]?.quote ?? null, f.sourceField, f.confidence);
  }
  for (const hn of output.hardNegatives) {
    insertFactor.run(scoreRunId, 'Hard negative', hn.quote, output.score, 0, hn.quote, hn.field, 'high');
  }
  applyRuleBlock(db, job, output, nowIso);

  deps.logger.info('job scored', { job_id: jobId, score_run_id: scoreRunId, mode: output.mode, score: output.score, confidence: output.confidence });
  return { status: 'scored', jobId, scoreRunId, mode: output.mode, score: output.score, confidence: output.confidence };
}

// A rule block sets the job's flag and events. An override is respected: once overridden,
// the rule does not block the job again.
function applyRuleBlock(db: Db, job: JobRow, output: ScoreOutput, nowIso: string): void {
  if (output.ruleBlocked && !job.rule_overridden_at && !job.rule_blocked) {
    db.prepare('UPDATE jobs SET rule_blocked = 1, rule_block_evidence = ? WHERE id = ?').run(JSON.stringify(output.hardNegatives), job.id);
    db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'rule_blocked', ?, ?)`).run(job.id, JSON.stringify({ evidence: output.hardNegatives }), nowIso);
  } else if (!output.ruleBlocked && job.rule_blocked) {
    db.prepare('UPDATE jobs SET rule_blocked = 0, rule_block_evidence = NULL WHERE id = ?').run(job.id);
    db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'rule_cleared', '{}', ?)`).run(job.id, nowIso);
  }
}

// Jobs that need a score: never scored, or changed since the last run (a pasted description
// or a merge). Verdicts and blocks do not count as changes.
export function jobsNeedingScore(db: Db, limit = Number.MAX_SAFE_INTEGER): number[] {
  const rows = db
    .prepare(
      `SELECT j.id FROM jobs j
       WHERE EXISTS (SELECT 1 FROM job_sources js WHERE js.job_id = j.id AND js.split_at IS NULL)
         AND (
           NOT EXISTS (SELECT 1 FROM score_runs r WHERE r.job_id = j.id)
           OR EXISTS (
             SELECT 1 FROM job_events e
             WHERE e.job_id = j.id AND e.type IN ('description_added', 'merged')
               AND e.created_at > (SELECT MAX(r.created_at) FROM score_runs r WHERE r.job_id = j.id)
           )
         )
       ORDER BY j.last_seen DESC, j.id DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Scores every job that needs it. Jobs go in batches of BATCH_SIZE, with up to BATCH_CONCURRENCY
// calls running at once. A failed call pauses scoring. Jobs scored before it stay scored.
export async function scoreNeeded(
  deps: ScoringDeps,
  aiAvailable: boolean,
  limit = Number.MAX_SAFE_INTEGER,
  onProgress?: (done: number, total: number) => void,
): Promise<{ scored: number; paused: boolean; errors: string[]; remaining: number }> {
  let scored = 0;
  const errors: string[] = [];
  const ids = jobsNeedingScore(deps.db, limit);
  const remaining = () => jobsNeedingScore(deps.db).length;
  onProgress?.(0, ids.length);
  const batches = chunk(ids, BATCH_SIZE);
  for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
    const group = batches.slice(i, i + BATCH_CONCURRENCY);
    const calls = aiAvailable ? await Promise.all(group.map((batch) => extractBatch(deps, batch))) : null;
    for (const [g, batch] of group.entries()) {
      const call = calls?.[g];
      if (call && !call.ok) {
        errors.push(call.error);
        return { scored, paused: true, errors, remaining: remaining() };
      }
      for (const jobId of batch) {
        const preset: AiResult | null = call && call.ok ? (call.results.get(jobId) ?? null) : null;
        const outcome = await scoreJob(deps, jobId, aiAvailable, preset);
        if (outcome.status === 'paused') {
          errors.push(outcome.error);
          return { scored, paused: true, errors, remaining: remaining() };
        }
        scored++;
        onProgress?.(scored, ids.length);
      }
    }
  }
  return { scored, paused: false, errors, remaining: remaining() };
}
