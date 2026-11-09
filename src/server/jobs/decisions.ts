import type { Db } from '../db/index.ts';
import { HttpError } from '../http/router.ts';
import { findApplicationMatch, progressJob, updateApplicationStatus } from '../applications.ts';
import { closeJob, reopenJob, setVerdict } from './actions.ts';

// The decisions a job can take. Each one is stored against the job id, so every view shows the same state.
export const BATCH_ACTIONS = ['progress', 'applied', 'not_interested', 'bring_back', 'not_available', 'reopen'] as const;
export type BatchAction = (typeof BATCH_ACTIONS)[number];

export interface DecisionContext {
  db: Db;
  nowIso: () => string;
  scoreVersionOf: (jobId: number) => number | null;
  aliases: Record<string, string>;
}

type JobForProgress = Parameters<typeof progressJob>[1];

function jobRow(db: Db, id: number): JobForProgress & { blocked_at: string | null; rule_blocked: number; closed_at: string | null } {
  const job = db
    .prepare('SELECT id, canonical_url, title, company, company_key, title_key, blocked_at, rule_blocked, closed_at FROM jobs WHERE id = ?')
    .get(id) as (JobForProgress & { blocked_at: string | null; rule_blocked: number; closed_at: string | null }) | undefined;
  if (!job) throw new HttpError(404, 'Job not found', 'not_found');
  return job;
}

// Progress saves the job to Analysis. A blocked or closed job is refused.
export function progressOne(ctx: DecisionContext, id: number, reason: string | null) {
  const job = jobRow(ctx.db, id);
  if (job.blocked_at || job.rule_blocked) throw new HttpError(409, 'A blocked job cannot be progressed. Override it first.', 'conflict');
  if (job.closed_at) throw new HttpError(409, 'This job is closed on LinkedIn. It can be progressed again if it is relisted.', 'conflict');
  return progressJob(ctx.db, job, { reason, scoreVersion: ctx.scoreVersionOf(id), nowIso: ctx.nowIso(), aliases: ctx.aliases });
}

// Applied works from any state. A job not yet progressed is saved first, then marked applied.
// Applied on a job already applied changes nothing.
export function markApplied(ctx: DecisionContext, id: number): void {
  const job = jobRow(ctx.db, id);
  const match = findApplicationMatch(ctx.db, job);
  if (match?.status === 'applied') return;
  const applicationId = match ? match.application_id : progressOne(ctx, id, null).applicationId;
  updateApplicationStatus(ctx.db, applicationId, 'applied', null, ctx.nowIso());
}

export function decide(ctx: DecisionContext, id: number, action: BatchAction): void {
  const now = ctx.nowIso();
  if (action === 'progress') progressOne(ctx, id, null);
  else if (action === 'applied') markApplied(ctx, id);
  else if (action === 'not_interested') setVerdict(ctx.db, id, 'bad', [], null, now);
  else if (action === 'bring_back') setVerdict(ctx.db, id, 'maybe', [], null, now);
  else if (action === 'not_available') closeJob(ctx.db, id, 'Not available on LinkedIn', now);
  else reopenJob(ctx.db, id, now);
}
