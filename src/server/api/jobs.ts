import { BLOCK_UNDO_WINDOW_MS } from '../../shared/app.ts';
import type { Db } from '../db/index.ts';
import type { Logger } from '../log.ts';
import { HttpError, type Router, type RouteHandler, sendJson } from '../http/router.ts';
import { ActionError, blockJob, mergeJobs, openListing, overrideBlock, setDescription, setVerdict, splitPosting, undoBlock } from '../jobs/actions.ts';
import { jobDetail, listJobs, stats, type Filter } from '../jobs/read.ts';
import { ProgressBlocked, progressJob, createApplication, updateApplicationStatus, APPLICATION_STATUSES, type ApplicationStatus } from '../applications.ts';
import { ContactError, createContact } from '../contacts.ts';
import { activeWeightProfile, saveWeightVersion, validateWeights, WeightError } from '../score/profile.ts';
import { normalizeCompany } from '../normalize/keys.ts';

export interface JobsApiDeps {
  db: Db;
  rescore: (jobId: number) => Promise<void>;
  logger: Logger;
  aliases: Record<string, string>;
  now: () => Date;
  lastRefreshAt: () => string | null;
  readerAuthor: string;
  scoreVersionOf: (jobId: number) => number | null;
}

// Wraps a route so domain errors become HTTP errors with the right status.
function guard(fn: RouteHandler): RouteHandler {
  return async (ctx) => {
    try {
      await fn(ctx);
    } catch (err) {
      if (err instanceof ActionError) throw new HttpError(err.status, err.message, 'action_failed');
      if (err instanceof ContactError || err instanceof WeightError) throw new HttpError(400, err.message, 'bad_request');
      if (err instanceof ProgressBlocked) {
        sendJson(ctx.res, 409, { error: 'already_applied', message: err.message, match: err.match });
        return;
      }
      throw err;
    }
  };
}

function jobId(params: Record<string, string>): number {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Job ID must be a whole number', 'bad_request');
  return id;
}

const FILTERS: Filter[] = ['all', 'good', 'review', 'blocked', 'applied'];

export function registerJobRoutes(router: Router, deps: JobsApiDeps): void {
  const { db } = deps;
  const nowIso = () => deps.now().toISOString();

  router.get('/jobs', ({ res, url }) => {
    const filter = (url.searchParams.get('filter') ?? 'all') as Filter;
    if (!FILTERS.includes(filter)) throw new HttpError(400, 'Unknown filter', 'bad_request');
    const direct = (url.searchParams.get('direct') ?? 'any') as 'any' | 'tier1' | 'tier2plus';
    const sort = (url.searchParams.get('sort') ?? 'score') as 'score' | 'age' | 'pay' | 'confidence';
    const result = listJobs(db, { filter, direct, sort });
    sendJson(res, 200, { items: result.items, counts: result.counts });
  });

  router.get('/stats', ({ res }) => {
    sendJson(res, 200, stats(db, deps.lastRefreshAt()));
  });

  router.get('/jobs/:id', ({ res, params }) => {
    const detail = jobDetail(db, jobId(params));
    if (!detail) throw new HttpError(404, 'Job not found', 'not_found');
    sendJson(res, 200, detail);
  });

  router.post('/jobs/:id/verdict', guard(async ({ res, params, json }) => {
    const body = await json<{ verdict?: string; reason_tags?: string[]; note?: string | null }>();
    const id = setVerdict(db, jobId(params), String(body.verdict ?? ''), Array.isArray(body.reason_tags) ? body.reason_tags.map(String) : [], body.note ?? null, nowIso());
    sendJson(res, 200, { feedback_id: id });
  }));

  router.post('/jobs/:id/progress', guard(async ({ res, params, json }) => {
    const body = await json<{ reason?: string | null }>().catch(() => ({} as { reason?: string | null }));
    const id = jobId(params);
    const job = db.prepare('SELECT id, canonical_url, title, company, company_key, title_key, blocked_at, rule_blocked FROM jobs WHERE id = ?').get(id) as
      | { id: number; canonical_url: string; title: string; company: string | null; company_key: string | null; title_key: string | null; blocked_at: string | null; rule_blocked: number }
      | undefined;
    if (!job) throw new HttpError(404, 'Job not found', 'not_found');
    if (job.blocked_at || job.rule_blocked) throw new HttpError(409, 'A blocked job cannot be progressed. Override it first.', 'conflict');
    const out = progressJob(db, job, { reason: body.reason ?? null, scoreVersion: deps.scoreVersionOf(id), nowIso: nowIso(), aliases: deps.aliases });
    sendJson(res, 200, { application_id: out.applicationId, stage: 'analysis', button: 'Saved to Analysis' });
  }));

  router.post('/jobs/:id/block', guard(async ({ res, params, json }) => {
    const body = await json<{ reason?: string }>();
    blockJob(db, jobId(params), String(body.reason ?? ''), nowIso());
    sendJson(res, 200, { undo_window_ms: BLOCK_UNDO_WINDOW_MS });
  }));

  router.post('/jobs/:id/undo-block', guard(({ res, params }) => {
    undoBlock(db, jobId(params), nowIso());
    sendJson(res, 200, { ok: true });
  }));

  router.post('/jobs/:id/override', guard(async ({ res, params, json }) => {
    const body = await json<{ reason?: string }>();
    overrideBlock(db, jobId(params), String(body.reason ?? ''), nowIso());
    sendJson(res, 200, { ok: true });
  }));

  router.post('/jobs/:id/listing-opened', guard(({ res, params }) => {
    const url = openListing(db, jobId(params), nowIso());
    sendJson(res, 200, { url });
  }));

  router.post('/jobs/:id/description', guard(async ({ res, params, json }) => {
    const body = await json<{ text?: string }>();
    const id = jobId(params);
    const result = setDescription(db, id, String(body.text ?? ''), nowIso());
    // A pasted description changes the evidence, so the job is scored again now.
    await deps.rescore(id);
    sendJson(res, 200, { merged: result.merged, rescored: true });
  }));

  router.post('/jobs/:id/split', guard(async ({ res, params, json }) => {
    const body = await json<{ posting_id?: number }>();
    const newJob = splitPosting(db, jobId(params), Number(body.posting_id), deps.aliases, nowIso());
    sendJson(res, 200, { new_job_id: newJob });
  }));

  // Keep grouped: another job with a similar title joins this one on purpose.
  router.post('/jobs/:id/group', guard(async ({ res, params, json }) => {
    const body = await json<{ from_job_id?: number }>();
    const target = jobId(params);
    const from = Number(body.from_job_id);
    if (!Number.isInteger(from) || from === target) throw new HttpError(400, 'Choose a different job to group', 'bad_request');
    mergeJobs(db, target, from, 'manual', 'kept grouped by the owner', nowIso());
    sendJson(res, 200, { ok: true });
  }));

  router.get('/settings/weights', ({ res }) => {
    const active = activeWeightProfile(db);
    const history = db.prepare('SELECT version, weights, author, reason, created_at FROM weight_profiles ORDER BY version DESC').all() as Array<Record<string, unknown>>;
    sendJson(res, 200, { active, history: history.map((h) => ({ ...h, weights: JSON.parse(String(h.weights)) })) });
  });

  router.post('/settings/weights', guard(async ({ res, json }) => {
    const body = await json<{ weights?: unknown; reason?: string }>();
    const weights = validateWeights(body.weights);
    const reason = String(body.reason ?? '').trim();
    if (!reason) throw new HttpError(400, 'A reason is needed for a weight change', 'bad_request');
    const next = saveWeightVersion(db, weights, reason, deps.readerAuthor, nowIso());
    deps.logger.info('weights changed', { version: next.version });
    sendJson(res, 200, { active: next });
  }));

  router.get('/applications', ({ res, url }) => {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const status = url.searchParams.get('status');
    const rows = db
      .prepare(
        `SELECT id, company, title, source_url, status, stage, applied_at, source_channel, notes, origin, created_at, updated_at
         FROM applications ORDER BY id DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    const filtered = rows.filter((r) => {
      if (status && r.status !== status) return false;
      if (!q) return true;
      return `${r.company} ${r.title}`.toLowerCase().includes(q);
    });
    sendJson(res, 200, { items: filtered });
  });

  router.post('/applications', guard(async ({ res, json }) => {
    const body = await json<{ company?: string; title?: string; source_url?: string | null; status?: string; applied_at?: string | null; source_channel?: string | null; notes?: string | null }>();
    const status = (body.status ?? 'saved') as ApplicationStatus;
    if (!(APPLICATION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, 'Unknown status', 'bad_request');
    const id = createApplication(
      db,
      { company: String(body.company ?? ''), title: String(body.title ?? ''), source_url: body.source_url ?? null, status, applied_at: body.applied_at ?? null, source_channel: body.source_channel ?? null, notes: body.notes ?? null },
      'manual',
      { nowIso: nowIso(), aliases: deps.aliases },
    );
    sendJson(res, 201, { id });
  }));

  router.patch('/applications/:id', guard(async ({ res, params, json }) => {
    const body = await json<{ status?: string; note?: string | null }>();
    const status = (body.status ?? '') as ApplicationStatus;
    if (!(APPLICATION_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, 'Unknown status', 'bad_request');
    updateApplicationStatus(db, Number(params.id), status, body.note ?? null, nowIso());
    sendJson(res, 200, { ok: true });
  }));

  router.post('/contacts', guard(async ({ res, json }) => {
    const body = await json<{ name?: string; company?: string; relationship?: string; channel?: string | null; provenance?: string | null }>();
    const id = createContact(db, { name: String(body.name ?? ''), company: String(body.company ?? ''), relationship: String(body.relationship ?? ''), channel: body.channel ?? null, provenance: body.provenance ?? null }, nowIso(), deps.aliases);
    sendJson(res, 201, { id, company_key: normalizeCompany(String(body.company ?? ''), deps.aliases) });
  }));
}
