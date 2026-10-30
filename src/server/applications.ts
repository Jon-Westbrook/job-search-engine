import type { Db } from './db/index.ts';
import { normalizeCompany, normalizeTitle } from './normalize/keys.ts';

export const APPLICATION_STATUSES = ['saved', 'applied', 'interviewing', 'rejected', 'offer'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface ApplicationInput {
  company: string;
  title: string;
  source_url?: string | null;
  status?: ApplicationStatus;
  applied_at?: string | null;
  source_channel?: string | null;
  notes?: string | null;
}

export interface ApplicationMatch {
  application_id: number;
  reason: 'linked job' | 'same URL' | 'same company and title';
  status: string;
  applied_at: string | null;
}

export interface JobForMatch {
  id: number;
  canonical_url: string;
  company_key: string | null;
  title_key: string | null;
}

// Precedence: a link to this job, then the same URL, then the same company and title.
// The first hit wins. The reason is shown with the warning.
export function findApplicationMatch(db: Db, job: JobForMatch): ApplicationMatch | null {
  const byLink = db
    .prepare('SELECT id, status, applied_at FROM applications WHERE job_id = ? ORDER BY id LIMIT 1')
    .get(job.id) as { id: number; status: string; applied_at: string | null } | undefined;
  if (byLink) return { application_id: byLink.id, reason: 'linked job', status: byLink.status, applied_at: byLink.applied_at };

  const byUrl = db
    .prepare('SELECT id, status, applied_at FROM applications WHERE source_url = ? ORDER BY id LIMIT 1')
    .get(job.canonical_url) as { id: number; status: string; applied_at: string | null } | undefined;
  if (byUrl) return { application_id: byUrl.id, reason: 'same URL', status: byUrl.status, applied_at: byUrl.applied_at };

  if (job.company_key && job.title_key) {
    const byKeys = db
      .prepare('SELECT id, status, applied_at FROM applications WHERE company_key = ? AND title_key = ? ORDER BY id LIMIT 1')
      .get(job.company_key, job.title_key) as { id: number; status: string; applied_at: string | null } | undefined;
    if (byKeys) {
      return { application_id: byKeys.id, reason: 'same company and title', status: byKeys.status, applied_at: byKeys.applied_at };
    }
  }
  return null;
}

export function createApplication(
  db: Db,
  input: ApplicationInput,
  origin: 'manual' | 'progress',
  opts: { jobId?: number | null; scoreVersion?: number | null; nowIso: string; aliases?: Record<string, string> },
): number {
  const companyKey = normalizeCompany(input.company, opts.aliases ?? {});
  const titleKey = normalizeTitle(input.title);
  if (!companyKey || !titleKey) throw new Error('An application needs a company and a title');
  const status = input.status ?? 'saved';
  const stage = status === 'saved' ? 'analysis' : 'submit';
  const inserted = db
    .prepare(
      `INSERT INTO applications (job_id, company, company_key, title, title_key, source_url, status, stage, applied_at,
         source_channel, notes, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.jobId ?? null,
      input.company.trim(),
      companyKey,
      input.title.trim(),
      titleKey,
      input.source_url ?? null,
      status,
      stage,
      input.applied_at ?? null,
      input.source_channel ?? null,
      input.notes ?? null,
      origin,
      opts.nowIso,
      opts.nowIso,
    );
  const id = Number(inserted.lastInsertRowid);
  db.prepare(
    `INSERT INTO application_events (application_id, type, from_value, to_value, note, score_version, created_at)
     VALUES (?, 'created', NULL, ?, ?, ?, ?)`,
  ).run(id, status, origin === 'progress' ? 'progressed from the Inbox' : 'added by hand', opts.scoreVersion ?? null, opts.nowIso);
  return id;
}

export class ProgressBlocked extends Error {
  readonly match: ApplicationMatch;
  constructor(match: ApplicationMatch) {
    super('This job already has an application. Enter a reason to continue.');
    this.match = match;
  }
}

// Progress creates a saved application and moves the job to Analysis. If a match already
// exists, a reason is required. The reason is recorded as an event.
export function progressJob(
  db: Db,
  job: JobForMatch & { title: string; company: string | null },
  opts: { reason?: string | null; scoreVersion?: number | null; nowIso: string; aliases?: Record<string, string> },
): { applicationId: number; match: ApplicationMatch | null } {
  const match = findApplicationMatch(db, job);
  if (match && !(opts.reason && opts.reason.trim())) throw new ProgressBlocked(match);
  const applicationId = createApplication(
    db,
    { company: job.company ?? 'Unknown company', title: job.title, source_url: job.canonical_url, status: 'saved' },
    'progress',
    { jobId: job.id, scoreVersion: opts.scoreVersion ?? null, nowIso: opts.nowIso, aliases: opts.aliases },
  );
  if (match && opts.reason) {
    db.prepare(
      `INSERT INTO application_events (application_id, type, from_value, to_value, note, score_version, created_at)
       VALUES (?, 'duplicate_reason', ?, ?, ?, ?, ?)`,
    ).run(applicationId, match.reason, String(match.application_id), opts.reason.trim(), opts.scoreVersion ?? null, opts.nowIso);
  }
  db.prepare(`UPDATE jobs SET stage = 'analysis' WHERE id = ?`).run(job.id);
  return { applicationId, match };
}

export function updateApplicationStatus(db: Db, applicationId: number, status: ApplicationStatus, note: string | null, nowIso: string): void {
  const current = db.prepare('SELECT status FROM applications WHERE id = ?').get(applicationId) as { status: string } | undefined;
  if (!current) throw new Error('Application not found');
  if (current.status === status) return;
  // The first move past Saved records the date. A later change keeps the original date.
  db.prepare(
    `UPDATE applications
     SET status = ?, stage = ?, updated_at = ?,
         applied_at = CASE WHEN ? = 'saved' THEN applied_at ELSE COALESCE(applied_at, ?) END
     WHERE id = ?`,
  ).run(status, status === 'saved' ? 'analysis' : 'submit', nowIso, status, nowIso, applicationId);
  db.prepare(
    `INSERT INTO application_events (application_id, type, from_value, to_value, note, created_at) VALUES (?, 'status', ?, ?, ?, ?)`,
  ).run(applicationId, current.status, status, note, nowIso);
}
