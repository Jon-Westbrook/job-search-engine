import { BLOCK_UNDO_WINDOW_MS } from '../../shared/app.ts';
import type { Db } from '../db/index.ts';
import type { Logger } from '../log.ts';
import { HttpError, type Router, type RouteHandler, sendJson } from '../http/router.ts';
import { ActionError, blockJob, closeJob, mergeJobs, openListing, reopenJob, overrideBlock, setDescription, setVerdict, splitPosting, undoBlock } from '../jobs/actions.ts';
import { jobDetail, listJobs, loadItems, stats, type Filter } from '../jobs/read.ts';
import { decisionResults } from '../jobs/results.ts';
import { ProgressBlocked, progressJob, createApplication, findApplicationMatch, updateApplicationStatus, APPLICATION_STATUSES, type ApplicationStatus } from '../applications.ts';
import { saveViews, savedViews, validateViews } from '../saved-views.ts';
import { ContactError, createContact } from '../contacts.ts';
import { buildNetwork } from '../network.ts';
import { listOutreach, recordOutreach, updateOutreach } from '../outreach.ts';
import type { OwnerMessage } from '../../shared/drafts.ts';
import { activeWeightProfile, saveWeightVersion, validateWeights, WeightError } from '../score/profile.ts';
import { normalizeCompany } from '../normalize/keys.ts';
import { loadSnapshot } from '../tracker/import-plan.ts';
import { planFromSnapshot } from '../tracker/import-plan.ts';
import { applyImport } from '../tracker/import-apply.ts';

export interface JobsApiDeps {
  db: Db;
  snapshotPath: string;
  rescore: (jobId: number) => Promise<void>;
  logger: Logger;
  aliases: Record<string, string>;
  now: () => Date;
  lastRefreshAt: () => string | null;
  readerAuthor: string;
  scoreVersionOf: (jobId: number) => number | null;
  ownerMessage: OwnerMessage;
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

const BATCH_ACTIONS = ['progress', 'applied', 'not_interested', 'bring_back', 'not_available', 'reopen'] as const;
type BatchAction = (typeof BATCH_ACTIONS)[number];

const FILTERS: Filter[] = ['all', 'undecided', 'good', 'review', 'progressed', 'not_interested', 'not_available', 'blocked', 'targets'];
const SORTS = ['score', 'age', 'pay', 'confidence', 'targets'] as const;

export function registerJobRoutes(router: Router, deps: JobsApiDeps): void {
  const { db } = deps;
  const nowIso = () => deps.now().toISOString();

  router.get('/jobs', ({ res, url }) => {
    const filter = (url.searchParams.get('filter') ?? 'all') as Filter;
    if (!FILTERS.includes(filter)) throw new HttpError(400, 'Unknown filter', 'bad_request');
    const direct = (url.searchParams.get('direct') ?? 'any') as 'any' | 'tier1' | 'tier2plus';
    const sortParam = url.searchParams.get('sort') ?? 'score';
    if (!(SORTS as readonly string[]).includes(sortParam)) throw new HttpError(400, 'Unknown sort', 'bad_request');
    const result = listJobs(db, { filter, direct, sort: sortParam as (typeof SORTS)[number] });
    sendJson(res, 200, { items: result.items, counts: result.counts });
  });

  router.get('/stats', ({ res }) => {
    sendJson(res, 200, stats(db, deps.lastRefreshAt()));
  });

  // Loaded only when the Results section is opened, since it reads every job.
  router.get('/results', ({ res }) => {
    const opened = new Set((db.prepare(`SELECT DISTINCT job_id FROM job_events WHERE type = 'listing_opened'`).all() as Array<{ job_id: number }>).map((r) => r.job_id));
    sendJson(res, 200, decisionResults(loadItems(db), opened));
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

  // Progress and the batch path share one check, so a blocked or closed job is refused the same way.
  const progressOne = (id: number, reason: string | null) => {
    const job = db.prepare('SELECT id, canonical_url, title, company, company_key, title_key, blocked_at, rule_blocked, closed_at FROM jobs WHERE id = ?').get(id) as
      | { id: number; canonical_url: string; title: string; company: string | null; company_key: string | null; title_key: string | null; blocked_at: string | null; rule_blocked: number; closed_at: string | null }
      | undefined;
    if (!job) throw new HttpError(404, 'Job not found', 'not_found');
    if (job.blocked_at || job.rule_blocked) throw new HttpError(409, 'A blocked job cannot be progressed. Override it first.', 'conflict');
    if (job.closed_at) throw new HttpError(409, 'This job is closed on LinkedIn. It can be progressed again if it is relisted.', 'conflict');
    return progressJob(db, job, { reason, scoreVersion: deps.scoreVersionOf(id), nowIso: nowIso(), aliases: deps.aliases });
  };

  router.post('/jobs/:id/progress', guard(async ({ res, params, json }) => {
    const body = await json<{ reason?: string | null }>().catch(() => ({} as { reason?: string | null }));
    const out = progressOne(jobId(params), body.reason ?? null);
    sendJson(res, 200, { application_id: out.applicationId, stage: 'analysis', button: 'Saved to Analysis' });
  }));

  // Marks the progressed job's application as applied, once the owner has sent it.
  const markApplied = (id: number, now: string) => {
    const job = db.prepare('SELECT id, canonical_url, company_key, title_key FROM jobs WHERE id = ?').get(id) as
      | { id: number; canonical_url: string; company_key: string | null; title_key: string | null }
      | undefined;
    if (!job) throw new HttpError(404, 'Job not found', 'not_found');
    const match = findApplicationMatch(db, job);
    if (!match) throw new HttpError(409, 'This job has not been progressed', 'conflict');
    updateApplicationStatus(db, match.application_id, 'applied', null, now);
  };

  const decide = (id: number, action: BatchAction) => {
    const now = nowIso();
    if (action === 'progress') progressOne(id, null);
    else if (action === 'applied') markApplied(id, now);
    else if (action === 'not_interested') setVerdict(db, id, 'bad', [], null, now);
    else if (action === 'bring_back') setVerdict(db, id, 'maybe', [], null, now);
    else if (action === 'not_available') closeJob(db, id, 'Not available on LinkedIn', now);
    else reopenJob(db, id, now);
  };

  // One request for a whole selection. Each job is checked on its own, so one that cannot change does not stop the rest.
  router.post('/jobs/batch', guard(async ({ res, json }) => {
    const body = await json<{ ids?: unknown; action?: unknown }>();
    const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
    if (ids.length === 0 || ids.length > 500 || ids.some((n) => !Number.isInteger(n) || n < 1)) {
      throw new HttpError(400, 'Choose between 1 and 500 jobs', 'bad_request');
    }
    if (!(BATCH_ACTIONS as readonly unknown[]).includes(body.action)) throw new HttpError(400, 'Unknown action', 'bad_request');
    const action = body.action as BatchAction;
    const failed: number[] = [];
    for (const id of ids) {
      try {
        decide(id, action);
      } catch {
        failed.push(id);
      }
    }
    sendJson(res, 200, { done: ids.length - failed.length, failed });
  }));

  router.get('/views', ({ res }) => {
    sendJson(res, 200, { views: savedViews(db) });
  });

  router.post('/views', guard(async ({ res, json }) => {
    const body = await json<{ views?: unknown }>();
    const views = validateViews(body.views);
    saveViews(db, views, nowIso());
    sendJson(res, 200, { views });
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

  router.post('/jobs/:id/close', guard(async ({ res, params, json }) => {
    const body = await json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
    closeJob(db, jobId(params), String(body.reason ?? ''), nowIso());
    sendJson(res, 200, { ok: true });
  }));

  router.post('/jobs/:id/reopen', guard(({ res, params }) => {
    reopenJob(db, jobId(params), nowIso());
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

  router.get('/network', ({ res }) => {
    sendJson(res, 200, { rows: buildNetwork(db, nowIso()), me: deps.ownerMessage });
  });

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
        `SELECT a.id, a.company, a.title, a.source_url, a.status, a.stage, a.applied_at, a.source_channel, a.notes, a.origin,
                a.created_at, a.updated_at, i.status AS import_status
         FROM applications a LEFT JOIN imports i ON i.application_id = a.id
         ORDER BY a.id DESC`,
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

  // LinkedIn outreach. The owner marks each step by hand; the app never sends or reads LinkedIn.
  router.get('/outreach', ({ res }) => {
    sendJson(res, 200, { items: listOutreach(db, nowIso()), me: deps.ownerMessage });
  });

  router.post('/outreach', guard(async ({ res, json }) => {
    const body = await json<{ person_key?: string; job_id?: number | null }>();
    const personKeyParam = String(body.person_key ?? '');
    if (!personKeyParam) throw new HttpError(400, 'A person is needed', 'bad_request');
    const jobIdParam = body.job_id === null || body.job_id === undefined ? null : Number(body.job_id);
    if (jobIdParam !== null && (!Number.isInteger(jobIdParam) || jobIdParam < 1)) throw new HttpError(400, 'Job ID must be a whole number', 'bad_request');
    const id = recordOutreach(db, { person_key: personKeyParam, job_id: jobIdParam }, nowIso());
    sendJson(res, 201, { id });
  }));

  router.patch('/outreach/:id', guard(async ({ res, params, json }) => {
    const body = await json<{ action?: string }>();
    updateOutreach(db, Number(params.id), String(body.action ?? ''), nowIso());
    sendJson(res, 200, { ok: true });
  }));

  // Tracker import. The server reads a snapshot made from the log on the owner's machine.
  // The plan is a dry run. Nothing is written until confirm is true.
  router.get('/tracker/import/plan', ({ res }) => {
    const snapshot = loadSnapshot(deps.snapshotPath);
    if (!snapshot) {
      sendJson(res, 200, { available: false, message: 'No log snapshot is loaded yet.' });
      return;
    }
    const plan = planFromSnapshot(snapshot);
    sendJson(res, 200, {
      available: true,
      generated_at: snapshot.generated_at,
      applications_in_log: plan.applications_in_log,
      counts: plan.counts,
      rows: plan.rows.map((r) => ({
        source: `${r.source_path}:${r.source_line}`,
        company: r.company,
        title: r.title,
        applied_at: r.applied_at,
        status: r.status,
        raw_status: r.raw_status,
        uncertain: r.uncertain,
        reasons: r.reasons,
      })),
    });
  });

  router.post('/tracker/import', guard(async ({ res, json }) => {
    const body = await json<{ confirm?: boolean }>();
    if (body.confirm !== true) throw new HttpError(400, 'Import needs confirm: true after the plan is reviewed', 'bad_request');
    const snapshot = loadSnapshot(deps.snapshotPath);
    if (!snapshot) throw new HttpError(409, 'No log snapshot is loaded yet', 'conflict');
    const result = applyImport(db, planFromSnapshot(snapshot), nowIso(), deps.aliases);
    deps.logger.info('tracker import applied', { inserted: result.inserted, skipped: result.skipped_already_imported, uncertain: result.uncertain });
    sendJson(res, 200, result);
  }));

  router.post('/contacts', guard(async ({ res, json }) => {
    const body = await json<{ name?: string; company?: string; relationship?: string; channel?: string | null; provenance?: string | null }>();
    const id = createContact(db, { name: String(body.name ?? ''), company: String(body.company ?? ''), relationship: String(body.relationship ?? ''), channel: body.channel ?? null, provenance: body.provenance ?? null }, nowIso(), deps.aliases);
    sendJson(res, 201, { id, company_key: normalizeCompany(String(body.company ?? ''), deps.aliases) });
  }));
}
