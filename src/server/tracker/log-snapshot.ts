import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Reads the job-search log without writing to it (brief section 13). It keeps only the
// structured fields the Tracker needs. Narrative text and contact names are not copied.
export const SNAPSHOT_SCHEMA = 'job-log-snapshot-v1';

export interface SnapshotEntry {
  path: string; // relative to the log root, for example entries/2026-10-26-x.md
  line: number; // 1-based line of the event_date field
  type: string | null;
  event_date: string | null;
  date_precision: string | null;
  end_date: string | null;
  logged_date: string | null;
  employer: string | null;
  opportunity: string | null;
  channel: string | null;
  status: string | null;
}

export interface Snapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  generated_at: string;
  entry_count: number;
  entries: SnapshotEntry[];
}

export function parseFrontmatter(text: string): { fields: Record<string, string>; line: number } | null {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end < 0) return null;
  const fields: Record<string, string> = {};
  let line = 0;
  for (let i = 1; i < end; i++) {
    const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(lines[i] ?? '');
    if (!m) continue;
    const key = m[1] ?? '';
    const raw = (m[2] ?? '').trim().replace(/^"(.*)"$/, '$1');
    fields[key] = raw;
    if (key === 'event_date') line = i + 1;
  }
  return { fields, line: line || 1 };
}

function nullable(value: string | undefined): string | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (!v || v === 'null' || v === '~') return null;
  return v;
}

export function buildSnapshot(logDir: string, nowIso: string): Snapshot {
  const dir = join(logDir, 'entries');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const entries: SnapshotEntry[] = [];
  for (const file of files) {
    const full = join(dir, file);
    if (!statSync(full).isFile()) continue;
    const parsed = parseFrontmatter(readFileSync(full, 'utf8'));
    if (!parsed) continue;
    const f = parsed.fields;
    const entry: SnapshotEntry = {
      path: `entries/${file}`,
      line: parsed.line,
      type: nullable(f.type),
      event_date: nullable(f.event_date),
      date_precision: nullable(f.date_precision),
      end_date: nullable(f.end_date),
      logged_date: nullable(f.logged_date),
      employer: nullable(f.employer),
      opportunity: nullable(f.opportunity),
      channel: nullable(f.channel),
      status: nullable(f.status),
    };
    entries.push(entry);
  }
  return { schema: SNAPSHOT_SCHEMA, generated_at: nowIso, entry_count: entries.length, entries };
}

export function snapshotHash(entry: SnapshotEntry): string {
  return createHash('sha256').update(JSON.stringify(entry)).digest('hex');
}
