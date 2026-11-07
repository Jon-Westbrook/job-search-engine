import type { JobListItem } from './types.ts';

// The one decision a job has in the Inbox. Each decision is stored in an existing table:
// progressed in applications, not available in job_events (closed), not interested in feedback (bad).
export type Decision = 'undecided' | 'progressed' | 'not_interested' | 'not_available' | 'blocked';

// Progressed wins, then not available, then not interested. Blocked jobs have no decision.
export function decisionOf(job: Pick<JobListItem, 'blocked' | 'rule_blocked' | 'applied' | 'in_analysis' | 'closed' | 'verdict'>): Decision {
  if (job.blocked || job.rule_blocked) return 'blocked';
  if (job.applied || job.in_analysis) return 'progressed';
  if (job.closed) return 'not_available';
  if (job.verdict === 'bad') return 'not_interested';
  return 'undecided';
}
