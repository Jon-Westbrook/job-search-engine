import type { Db } from './db/index.ts';
import { normalizeCompany, normalizeLocation, normalizeTitle, titleSimilarity, WEAK_TITLE_THRESHOLD } from './normalize/keys.ts';

export interface PostingRow {
  id: number;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  arrangement: string | null;
  posted_at: string | null;
  pay_min: number | null;
  pay_max: number | null;
  pay_period: string | null;
  pay_currency: string | null;
  pay_annualized: number | null;
  alert_received_at: string;
  source_id: string;
}

export type GroupDecision =
  | { postingId: number; jobId: number; decision: 'created'; reason: string }
  | { postingId: number; jobId: number; decision: 'exact'; reason: string };

// Attaches every source posting that has no active job. Exact matches join an existing
// job. Everything else becomes a new job. Weak matches stay separate and are reported
// by weakMatchesFor(). Grouping never deletes a posting or a job.
export function groupNewPostings(db: Db, aliases: Record<string, string>, nowIso: string): GroupDecision[] {
  const rows = db
    .prepare(
      `SELECT sp.* FROM source_postings sp
       WHERE NOT EXISTS (SELECT 1 FROM job_sources js WHERE js.posting_id = sp.id AND js.split_at IS NULL)
       ORDER BY sp.id`,
    )
    .all() as unknown as PostingRow[];

  const decisions: GroupDecision[] = [];
  for (const row of rows) {
    const existing = db
      .prepare(
        `SELECT j.id FROM jobs j
         WHERE j.canonical_url = ?
           AND EXISTS (SELECT 1 FROM job_sources js WHERE js.job_id = j.id AND js.split_at IS NULL)
         ORDER BY j.id LIMIT 1`,
      )
      .get(row.url) as { id: number } | undefined;

    if (existing) {
      attachPosting(db, existing.id, row, 'exact', 'same LinkedIn job URL', aliases, nowIso);
      decisions.push({ postingId: row.id, jobId: existing.id, decision: 'exact', reason: 'same LinkedIn job URL' });
    } else {
      const jobId = createJob(db, row, aliases, nowIso);
      decisions.push({ postingId: row.id, jobId, decision: 'created', reason: 'no exact match' });
    }
  }
  return decisions;
}

export function createJob(db: Db, row: PostingRow, aliases: Record<string, string>, nowIso: string): number {
  const companyKey = normalizeCompany(row.company, aliases);
  const titleKey = normalizeTitle(row.title);
  const locationKey = normalizeLocation(row.location);
  const inserted = db
    .prepare(
      `INSERT INTO jobs (canonical_url, title, company, location, arrangement, company_key, title_key, location_key,
         comp_min, comp_max, comp_period, comp_currency, comp_annualized, posted_at, first_seen, last_seen, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.url,
      row.title,
      row.company,
      row.location,
      row.arrangement,
      companyKey,
      titleKey,
      locationKey,
      row.pay_min,
      row.pay_max,
      row.pay_period,
      row.pay_currency,
      row.pay_annualized,
      row.posted_at,
      nowIso,
      nowIso,
      nowIso,
    );
  const jobId = Number(inserted.lastInsertRowid);
  db.prepare(
    `INSERT INTO job_sources (job_id, posting_id, match_type, match_reason, created_at) VALUES (?, ?, 'origin', 'first listing seen', ?)`,
  ).run(jobId, row.id, nowIso);
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'created', ?, ?)`).run(
    jobId,
    JSON.stringify({ posting_id: row.id }),
    nowIso,
  );
  return jobId;
}

// Adds a posting to an existing job. Missing job fields are filled from the posting.
// Existing values are never overwritten with null.
export function attachPosting(
  db: Db,
  jobId: number,
  row: PostingRow,
  matchType: 'exact' | 'manual',
  reason: string,
  aliases: Record<string, string>,
  nowIso: string,
): void {
  db.prepare(`INSERT INTO job_sources (job_id, posting_id, match_type, match_reason, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    jobId,
    row.id,
    matchType,
    reason,
    nowIso,
  );
  db.prepare(
    `UPDATE jobs SET
       last_seen = ?,
       location = COALESCE(location, ?),
       arrangement = COALESCE(arrangement, ?),
       location_key = COALESCE(location_key, ?),
       company_key = COALESCE(company_key, ?),
       comp_min = COALESCE(comp_min, ?),
       comp_max = COALESCE(comp_max, ?),
       comp_period = COALESCE(comp_period, ?),
       comp_currency = COALESCE(comp_currency, ?),
       comp_annualized = COALESCE(comp_annualized, ?),
       posted_at = COALESCE(posted_at, ?)
     WHERE id = ?`,
  ).run(
    nowIso,
    row.location,
    row.arrangement,
    normalizeLocation(row.location),
    normalizeCompany(row.company, aliases),
    row.pay_min,
    row.pay_max,
    row.pay_period,
    row.pay_currency,
    row.pay_annualized,
    row.posted_at,
    jobId,
  );
  db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'merged', ?, ?)`).run(
    jobId,
    JSON.stringify({ posting_id: row.id, match_type: matchType, reason }),
    nowIso,
  );
}

export interface WeakMatch {
  jobId: number;
  title: string;
  company: string | null;
  url: string;
  similarity: number;
}

// Jobs that share the company and a similar title, but are not the same listing.
// Shown as a duplicate warning. They stay separate.
export function weakMatchesFor(db: Db, jobId: number): WeakMatch[] {
  const job = db.prepare('SELECT company_key, title_key FROM jobs WHERE id = ?').get(jobId) as
    | { company_key: string | null; title_key: string | null }
    | undefined;
  if (!job?.company_key || !job.title_key) return [];
  const candidates = db
    .prepare(
      `SELECT id, title, company, canonical_url, title_key FROM jobs
       WHERE id <> ? AND company_key = ?
         AND EXISTS (SELECT 1 FROM job_sources js WHERE js.job_id = jobs.id AND js.split_at IS NULL)`,
    )
    .all(jobId, job.company_key) as Array<{ id: number; title: string; company: string | null; canonical_url: string; title_key: string | null }>;
  const out: WeakMatch[] = [];
  for (const c of candidates) {
    if (!c.title_key) continue;
    const similarity = c.title_key === job.title_key ? 1 : titleSimilarity(job.title_key, c.title_key);
    if (similarity >= WEAK_TITLE_THRESHOLD) {
      out.push({ jobId: c.id, title: c.title, company: c.company, url: c.canonical_url, similarity });
    }
  }
  return out.sort((a, b) => b.similarity - a.similarity);
}
