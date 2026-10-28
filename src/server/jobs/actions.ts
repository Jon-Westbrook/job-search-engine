import { createHash } from 'node:crypto';
import { BLOCK_UNDO_WINDOW_MS } from '../../shared/app.ts';
import type { Db } from '../db/index.ts';
import { attachPosting, createJob, type PostingRow } from '../grouping.ts';
import { foldText } from '../normalize/keys.ts';

export const VERDICTS = ['good', 'maybe', 'bad'] as const;
export type Verdict = (typeof VERDICTS)[number];

// Starting reason-tag list (brief section 10). To be approved by the owner.
export const REASON_TAGS = ['Role fit', 'Seniority', 'Pay', 'Location', 'Visa', 'Stack', 'Company', 'Other'] as const;

export class ActionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface JobRow {
  id: number;
  canonical_url: string;
  company_key: string | null;
  title_key: string | null;
  location_key: string | null;
  description_fingerprint: string | null;
  blocked_at: string | null;
  blocked_reason: string | null;
  rule_blocked: number;
  rule_overridden_at: string | null;
  stage: string;
}

function requireJob(db: Db, jobId: number): JobRow {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as unknown as JobRow | undefined;
  if (!job) throw new ActionError(404, 'Job not found');
  return job;
}

// Verdicts are labels. They are stored as feedback and never change a score or a weight.
export function setVerdict(db: Db, jobId: number, verdict: string, reasonTags: string[], note: string | null, nowIso: string): number {
  requireJob(db, jobId);
  if (!(VERDICTS as readonly string[]).includes(verdict)) throw new ActionError(400, 'Verdict must be good, maybe, or bad');
  const tags = [...new Set(reasonTags)];
  for (const t of tags) {
    if (!(REASON_TAGS as readonly string[]).includes(t)) throw new ActionError(400, `Unknown reason tag: ${t}`);
  }
  if (note && note.length > 500) throw new ActionError(400, 'The note can be at most 500 characters');
  const row = db
    .prepare('INSERT INTO feedback (job_id, verdict, reason_tags, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(jobId, verdict, JSON.stringify(tags), note && note.trim() ? note.trim() : null, nowIso);
  return Number(row.lastInsertRowid);
}

export function blockJob(db: Db, jobId: number, reason: string, nowIso: string): void {
  const job = requireJob(db, jobId);
  if (job.blocked_at) throw new ActionError(409, 'This job is already blocked');
  if (!reason.trim()) throw new ActionError(400, 'A block needs a reason');
  db.prepare(`UPDATE jobs SET blocked_at = ?, blocked_reason = ?, block_scope = 'job' WHERE id = ?`).run(nowIso, reason.trim(), jobId);
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'blocked', ?, ?)`).run(jobId, JSON.stringify({ reason: reason.trim() }), nowIso);
}

// Undo works only within the undo window. After that, Override and review is the way back.
export function undoBlock(db: Db, jobId: number, nowIso: string): void {
  const job = requireJob(db, jobId);
  if (!job.blocked_at) throw new ActionError(409, 'This job is not blocked');
  const age = Date.parse(nowIso) - Date.parse(job.blocked_at);
  if (age > BLOCK_UNDO_WINDOW_MS) throw new ActionError(409, 'The undo window has passed. Use Override and review.');
  db.prepare(`UPDATE jobs SET blocked_at = NULL, blocked_reason = NULL, block_scope = NULL WHERE id = ?`).run(jobId);
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'block_undone', '{}', ?)`).run(jobId, nowIso);
}

// Clears a user block or a rule block. Needs a reason, which is stored as an event.
export function overrideBlock(db: Db, jobId: number, reason: string, nowIso: string): void {
  const job = requireJob(db, jobId);
  if (!job.blocked_at && !job.rule_blocked) throw new ActionError(409, 'Only blocked jobs can be overridden');
  if (!reason.trim()) throw new ActionError(400, 'Override needs a reason');
  if (job.blocked_at) {
    db.prepare(`UPDATE jobs SET blocked_at = NULL, blocked_reason = NULL, block_scope = NULL WHERE id = ?`).run(jobId);
  }
  if (job.rule_blocked) {
    db.prepare('UPDATE jobs SET rule_blocked = 0, rule_overridden_at = ? WHERE id = ?').run(nowIso, jobId);
  }
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'override', ?, ?)`).run(
    jobId,
    JSON.stringify({ reason: reason.trim(), was_user_block: Boolean(job.blocked_at), was_rule_block: Boolean(job.rule_blocked) }),
    nowIso,
  );
}

export function openListing(db: Db, jobId: number, nowIso: string): string {
  const job = requireJob(db, jobId);
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'listing_opened', '{}', ?)`).run(jobId, nowIso);
  return job.canonical_url;
}

export function descriptionFingerprint(text: string): string {
  return createHash('sha256').update(foldText(text)).digest('hex');
}

// A pasted description is data. It sets the fingerprint and records the paste. If another
// job has the same company, title, location, and fingerprint, the two merge (strong).
// The merged job keeps a block if either job was blocked.
export function setDescription(db: Db, jobId: number, text: string, nowIso: string): { merged: number[] } {
  const job = requireJob(db, jobId);
  const trimmed = text.trim();
  if (trimmed.length < 40) throw new ActionError(400, 'Paste the full description so it can be matched');
  if (trimmed.length > 60_000) throw new ActionError(400, 'The description is too long');
  const fingerprint = descriptionFingerprint(trimmed);
  db.prepare('INSERT INTO job_descriptions (job_id, text, fingerprint, source, created_at) VALUES (?, ?, ?, ?, ?)').run(jobId, trimmed, fingerprint, 'pasted', nowIso);
  db.prepare('UPDATE jobs SET description_fingerprint = ? WHERE id = ?').run(fingerprint, jobId);
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'description_added', ?, ?)`).run(jobId, JSON.stringify({ fingerprint }), nowIso);

  const twins = db
    .prepare(
      `SELECT id FROM jobs
       WHERE id <> ? AND description_fingerprint = ? AND company_key IS ? AND title_key IS ? AND location_key IS ?
         AND EXISTS (SELECT 1 FROM job_sources js WHERE js.job_id = jobs.id AND js.split_at IS NULL)`,
    )
    .all(jobId, fingerprint, job.company_key, job.title_key, job.location_key) as Array<{ id: number }>;

  const merged: number[] = [];
  for (const twin of twins) {
    mergeJobs(db, jobId, twin.id, 'strong', 'same company, title, location, and description', nowIso);
    merged.push(twin.id);
  }
  return { merged };
}

// Moves the active sources of one job into another, then marks the source job as merged.
// Inherits a block when the source job was blocked and the target is not.
export function mergeJobs(db: Db, targetId: number, fromId: number, matchType: 'strong' | 'manual', reason: string, nowIso: string): void {
  const from = requireJob(db, fromId);
  const target = requireJob(db, targetId);
  db.prepare(`UPDATE job_sources SET job_id = ?, match_type = ?, match_reason = ? WHERE job_id = ? AND split_at IS NULL`).run(targetId, matchType, reason, fromId);
  if (from.blocked_at && !target.blocked_at) {
    db.prepare(`UPDATE jobs SET blocked_at = ?, blocked_reason = ?, block_scope = 'job' WHERE id = ?`).run(from.blocked_at, from.blocked_reason, targetId);
  }
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'merged', ?, ?)`).run(
    targetId,
    JSON.stringify({ from_job: fromId, match_type: matchType, reason }),
    nowIso,
  );
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'merged', ?, ?)`).run(
    fromId,
    JSON.stringify({ into_job: targetId, match_type: matchType, reason }),
    nowIso,
  );
}

// Split: a posting leaves this job and becomes its own job. The link ends with split_at.
export function splitPosting(db: Db, jobId: number, postingId: number, aliases: Record<string, string>, nowIso: string): number {
  requireJob(db, jobId);
  const link = db
    .prepare('SELECT id FROM job_sources WHERE job_id = ? AND posting_id = ? AND split_at IS NULL')
    .get(jobId, postingId) as { id: number } | undefined;
  if (!link) throw new ActionError(404, 'That listing is not part of this job');
  const activeCount = (db.prepare('SELECT COUNT(*) AS n FROM job_sources WHERE job_id = ? AND split_at IS NULL').get(jobId) as { n: number }).n;
  if (activeCount < 2) throw new ActionError(409, 'A job with one listing cannot be split');
  db.prepare('UPDATE job_sources SET split_at = ? WHERE id = ?').run(nowIso, link.id);
  const row = postingRow(db, postingId);
  const newJobId = createJob(db, row, aliases, nowIso);
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'split', ?, ?)`).run(
    jobId,
    JSON.stringify({ posting_id: postingId, new_job_id: newJobId }),
    nowIso,
  );
  return newJobId;
}

// Keep grouped: a weak-match listing joins another job on purpose.
export function groupPostingInto(db: Db, targetJobId: number, postingId: number, reason: string, aliases: Record<string, string>, nowIso: string): void {
  requireJob(db, targetJobId);
  const current = db
    .prepare('SELECT job_id, id FROM job_sources WHERE posting_id = ? AND split_at IS NULL')
    .get(postingId) as { job_id: number; id: number } | undefined;
  if (current?.job_id === targetJobId) throw new ActionError(409, 'That listing is already in this job');
  if (current) {
    db.prepare('UPDATE job_sources SET split_at = ? WHERE id = ?').run(nowIso, current.id);
    db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'grouped', ?, ?)`).run(
      current.job_id,
      JSON.stringify({ posting_id: postingId, moved_to: targetJobId, reason }),
      nowIso,
    );
  }
  attachPosting(db, targetJobId, postingRow(db, postingId), 'manual', reason, aliases, nowIso);
}

function postingRow(db: Db, postingId: number): PostingRow {
  const row = db.prepare('SELECT * FROM source_postings WHERE id = ?').get(postingId) as unknown as PostingRow | undefined;
  if (!row) throw new ActionError(404, 'Listing not found');
  return row;
}

