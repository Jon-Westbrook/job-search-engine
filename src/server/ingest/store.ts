import { createHash } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { ParsedPosting } from './linkedin.ts';

export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged';

// A stable fingerprint of the parsed listing. Timestamps of observation are excluded,
// so re-reading the same alert produces the same hash.
export function postingHash(p: ParsedPosting, parserVersion: string): string {
  const stable = {
    url: p.url,
    title: p.title,
    company: p.company,
    location: p.location,
    arrangement: p.arrangement,
    postedAt: p.postedAt,
    pay: p.pay,
    applicantCount: p.applicantCount,
    easyApply: p.easyApply,
    connectionHint: p.connectionHint,
    rawFields: p.rawFields,
    parserVersion,
  };
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

// Inserts a source posting, or refreshes it when it was seen before. Rows are never
// deleted. Reprocessing the same message changes nothing except last_seen.
export function upsertPosting(db: Db, p: ParsedPosting, nowIso: string, parserVersion: string): UpsertOutcome {
  const hash = postingHash(p, parserVersion);
  const existing = db
    .prepare('SELECT id, raw_hash FROM source_postings WHERE provider = ? AND source_id = ?')
    .get(p.provider, p.sourceId) as { id: number; raw_hash: string } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO source_postings (
        provider, source_id, message_id, thread_id, url, title, company, location, arrangement,
        posted_at, alert_received_at, pay_min, pay_max, pay_currency, pay_period, pay_annualized,
        applicant_count, easy_apply, connection_hint, raw_fields, raw_hash, parser_version, first_seen, last_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...postingValues(p, hash, parserVersion, nowIso, nowIso));
    return 'inserted';
  }

  if (existing.raw_hash === hash) {
    db.prepare('UPDATE source_postings SET last_seen = ? WHERE id = ?').run(nowIso, existing.id);
    return 'unchanged';
  }

  db.prepare(
    `UPDATE source_postings SET
      message_id = ?, thread_id = ?, url = ?, title = ?, company = ?, location = ?, arrangement = ?,
      posted_at = ?, alert_received_at = ?, pay_min = ?, pay_max = ?, pay_currency = ?, pay_period = ?,
      pay_annualized = ?, applicant_count = ?, easy_apply = ?, connection_hint = ?, raw_fields = ?,
      raw_hash = ?, parser_version = ?, last_seen = ?
     WHERE id = ?`,
  ).run(
    p.messageId,
    p.threadId,
    p.url,
    p.title,
    p.company,
    p.location,
    p.arrangement,
    p.postedAt,
    p.alertReceivedAt,
    p.pay?.min ?? null,
    p.pay?.max ?? null,
    p.pay?.currency ?? null,
    p.pay?.period ?? null,
    p.pay ? (p.pay.annualized ? 1 : 0) : null,
    p.applicantCount,
    p.easyApply ? 1 : null,
    JSON.stringify(p.connectionHint),
    JSON.stringify(p.rawFields),
    hash,
    parserVersion,
    nowIso,
    existing.id,
  );
  return 'updated';
}

function postingValues(p: ParsedPosting, hash: string, parserVersion: string, first: string, last: string): Array<string | number | null> {
  return [
    p.provider,
    p.sourceId,
    p.messageId,
    p.threadId,
    p.url,
    p.title,
    p.company,
    p.location,
    p.arrangement,
    p.postedAt,
    p.alertReceivedAt,
    p.pay?.min ?? null,
    p.pay?.max ?? null,
    p.pay?.currency ?? null,
    p.pay?.period ?? null,
    p.pay ? (p.pay.annualized ? 1 : 0) : null,
    p.applicantCount,
    p.easyApply ? 1 : null,
    JSON.stringify(p.connectionHint),
    JSON.stringify(p.rawFields),
    hash,
    parserVersion,
    first,
    last,
  ];
}

export function getCursor(db: Db, sourceId: string): string | null {
  const row = db.prepare('SELECT cursor_at FROM source_configs WHERE id = ?').get(sourceId) as { cursor_at: string | null } | undefined;
  return row?.cursor_at ?? null;
}

export function setCursor(db: Db, sourceId: string, cursorIso: string, nowIso: string): void {
  db.prepare('UPDATE source_configs SET cursor_at = ?, updated_at = ? WHERE id = ?').run(cursorIso, nowIso, sourceId);
}

// Makes the database match config/sources.json without touching the cursor.
export function seedSources(
  db: Db,
  sources: Array<{ id: string; type: 'gmail'; enabled: boolean; query: string; overlap_days: number; initial_lookback_days: number; parser_version: string }>,
  nowIso: string,
): void {
  const upsert = db.prepare(
    `INSERT INTO source_configs (id, type, enabled, query, overlap_days, initial_lookback_days, parser_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type = excluded.type, enabled = excluded.enabled, query = excluded.query,
       overlap_days = excluded.overlap_days, initial_lookback_days = excluded.initial_lookback_days,
       parser_version = excluded.parser_version, updated_at = excluded.updated_at`,
  );
  for (const s of sources) {
    upsert.run(s.id, s.type, s.enabled ? 1 : 0, s.query, s.overlap_days, s.initial_lookback_days, s.parser_version, nowIso);
  }
}
