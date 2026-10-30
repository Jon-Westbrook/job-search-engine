import type { Db } from '../db/index.ts';

// When an alert gives no posting time, the earliest alert that showed the job stands in for it.
// The job was posted on or before that alert, so the age it gives is a floor: the real age is
// at least this old. The earliest observation is used, not the latest, because a later alert
// does not make the job newer.
export function earliestAlertAt(db: Db, jobId: number): string | null {
  const row = db
    .prepare(
      `SELECT MIN(po.alert_received_at) AS first FROM posting_observations po
       JOIN job_sources js ON js.posting_id = po.posting_id
       WHERE js.job_id = ? AND js.split_at IS NULL`,
    )
    .get(jobId) as { first: string | null };
  return row.first;
}
