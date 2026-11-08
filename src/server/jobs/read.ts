import type { Db } from '../db/index.ts';
import { findApplicationMatch, type ApplicationMatch } from '../applications.ts';
import { weakMatchesFor } from '../grouping.ts';
import { GOOD_FIT_THRESHOLD, REVIEW_THRESHOLD } from '../../shared/app.ts';
import { earliestAlertAt } from './posted.ts';
import { askedFor } from '../outreach.ts';
import type { Band, Confidence, Filter, JobListItem, Verdict } from '../../shared/types.ts';
import { SOURCE_CHANNEL_KEYS, isSourceChannel, type SourceChannel } from '../../shared/channels.ts';
import { decisionOf } from '../../shared/decision.ts';

export type { Band, Filter, JobListItem };


export interface JobRow {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  arrangement: string | null;
  posted_at: string | null;
  comp_min: number | null;
  comp_max: number | null;
  comp_period: string | null;
  comp_currency: string | null;
  comp_annualized: number | null;
  canonical_url: string;
  company_key: string | null;
  title_key: string | null;
  blocked_at: string | null;
  blocked_reason: string | null;
  rule_blocked: number;
  rule_block_evidence: string | null;
  rule_overridden_at: string | null;
  closed_at: string | null;
  closed_reason: string | null;
  target_name: string | null;
  first_seen: string;
  last_seen: string;
  run_id: number | null;
  score: number | null;
  confidence: string | null;
  mode: string | null;
  flags: string | null;
  missing: string | null;
  scored_at: string | null;
  weight_version: number | null;
  verdict: string | null;
  verdict_tags: string | null;
  source_count: number;
  direct_value: string | null;
  tn_value: string | null;
}

const LIST_SQL = `
WITH latest_run AS (
  SELECT r.* FROM score_runs r WHERE r.id IN (SELECT MAX(id) FROM score_runs GROUP BY job_id)
),
latest_verdict AS (
  SELECT f.job_id, f.verdict, f.reason_tags FROM feedback f WHERE f.id IN (SELECT MAX(id) FROM feedback GROUP BY job_id)
)
SELECT j.id, j.title, j.company, j.location, j.arrangement, j.posted_at, j.comp_min, j.comp_max, j.comp_period,
       j.comp_currency, j.comp_annualized, j.canonical_url, j.company_key, j.title_key, j.blocked_at, j.blocked_reason,
       j.rule_blocked, j.rule_block_evidence, j.rule_overridden_at, j.closed_at, j.closed_reason, j.first_seen, j.last_seen,
       tg.name AS target_name,
       lr.id AS run_id, lr.score, lr.confidence, lr.mode, lr.flags, lr.missing, lr.created_at AS scored_at,
       wp.version AS weight_version,
       lv.verdict AS verdict, lv.reason_tags AS verdict_tags,
       (SELECT COUNT(*) FROM job_sources js WHERE js.job_id = j.id AND js.split_at IS NULL) AS source_count,
       (SELECT sf.ai_value FROM score_factors sf WHERE sf.score_run_id = lr.id AND sf.factor = 'Direct line') AS direct_value,
       (SELECT sf.ai_value FROM score_factors sf WHERE sf.score_run_id = lr.id AND sf.factor = 'TN and visa fit') AS tn_value
FROM jobs j
LEFT JOIN latest_run lr ON lr.job_id = j.id
LEFT JOIN weight_profiles wp ON wp.id = lr.weight_profile_id
LEFT JOIN latest_verdict lv ON lv.job_id = j.id
LEFT JOIN targets tg ON tg.company_key = j.company_key
WHERE EXISTS (SELECT 1 FROM job_sources js WHERE js.job_id = j.id AND js.split_at IS NULL)
`;

export function loadJobRows(db: Db): JobRow[] {
  return db.prepare(LIST_SQL).all() as unknown as JobRow[];
}

export function bandFor(row: { blocked_at: string | null; rule_blocked: number; score: number | null; flags: string[] }): Band {
  if (row.blocked_at || row.rule_blocked) return 'blocked';
  if (row.score === null) return 'unscored';
  if (row.score >= GOOD_FIT_THRESHOLD) return 'good';
  const reviewFlag = row.flags.some((f) => f.startsWith('Review:'));
  if (row.score >= REVIEW_THRESHOLD || reviewFlag) return 'review';
  return 'low';
}

export function directTier(value: string | null): 0 | 1 | 2 | 3 {
  const m = /tier (\d)/.exec(value ?? '');
  return m ? (Number(m[1]) as 1 | 2 | 3) : 0;
}

export function payText(row: JobRow): JobListItem['pay'] {
  if (row.comp_min === null || row.comp_max === null) return null;
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  const range = row.comp_min === row.comp_max ? fmt(row.comp_min) : `${fmt(row.comp_min)} to ${fmt(row.comp_max)}`;
  const period = row.comp_period === 'hour' ? '/hr' : row.comp_period === 'year' ? '/yr' : '';
  return {
    text: `${range}${period}`,
    min: row.comp_min,
    max: row.comp_max,
    period: row.comp_period,
    annualized: row.comp_annualized === 1,
  };
}

const APPLIED_STATUSES = new Set(['applied', 'interviewing', 'rejected', 'offer']);

// Who was asked about this role, in a short tag: one name, or a count.
function askedText(db: Db, jobId: number): string | null {
  const names = askedFor(db, jobId);
  if (names.length === 0) return null;
  return names.length === 1 ? `Asked ${names[0]}` : `Asked ${names.length} people`;
}

// The channels each job came from, read in one query. A job lists its channels in SOURCE_CHANNELS order.
export function channelMap(db: Db): Map<number, SourceChannel[]> {
  const rows = db
    .prepare(
      `SELECT js.job_id AS job_id, sp.provider AS provider FROM job_sources js
       JOIN source_postings sp ON sp.id = js.posting_id WHERE js.split_at IS NULL`,
    )
    .all() as Array<{ job_id: number; provider: string }>;
  const map = new Map<number, SourceChannel[]>();
  for (const row of rows) {
    if (!isSourceChannel(row.provider)) continue;
    const list = map.get(row.job_id) ?? [];
    if (!list.includes(row.provider)) list.push(row.provider);
    map.set(row.job_id, list.sort((a, b) => SOURCE_CHANNEL_KEYS.indexOf(a) - SOURCE_CHANNEL_KEYS.indexOf(b)));
  }
  return map;
}

export function loadItems(db: Db): JobListItem[] {
  const channels = channelMap(db);
  return loadJobRows(db).map((row) => toItem(db, row, channels.get(row.id) ?? []));
}

function toItem(db: Db, row: JobRow, channels: SourceChannel[]): JobListItem {
  const flags = parseList(row.flags);
  const missing = parseList(row.missing);
  const match: ApplicationMatch | null = findApplicationMatch(db, { id: row.id, canonical_url: row.canonical_url, company_key: row.company_key, title_key: row.title_key });
  const tier = directTier(row.direct_value);
  const blockedAt = row.blocked_at;
  const estimatedAt = row.posted_at ? null : earliestAlertAt(db, row.id);
  return {
    id: row.id,
    title: row.title,
    url: row.canonical_url,
    company: row.company,
    location: row.location,
    arrangement: row.arrangement,
    channels,
    posted_at: estimatedAt ?? row.posted_at,
    posted_estimated: !row.posted_at && estimatedAt !== null,
    pay: payText(row),
    score: row.score,
    confidence: row.confidence as Confidence | null,
    mode: row.mode as JobListItem['mode'],
    weight_version: row.weight_version,
    verdict: row.verdict as Verdict | null,
    tn_label: row.tn_value,
    direct_tier: tier,
    direct_label: tier === 0 ? 'None' : tier === 1 ? 'Direct: tier 1' : tier === 2 ? 'Direct: tier 2' : 'Direct: tier 3',
    flags,
    missing,
    blocked: blockedAt ? { at: blockedAt, reason: row.blocked_reason ?? '' } : null,
    closed: row.closed_at ? { at: row.closed_at, reason: row.closed_reason ?? '' } : null,
    target: row.target_name,
    asked: askedText(db, row.id),
    rule_blocked: row.rule_blocked === 1,
    // Only a status past Saved counts as applied. A progressed job is Saved and shows In Analysis.
    applied: match && APPLIED_STATUSES.has(match.status) ? { date: match.applied_at, reason: match.reason, status: match.status } : null,
    in_analysis: match && match.status === 'saved' ? { reason: match.reason } : null,
    possible_duplicate: weakMatchesFor(db, row.id).length > 0,
    source_count: row.source_count,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    band: bandFor({ blocked_at: blockedAt, rule_blocked: row.rule_blocked, score: row.score, flags }),
  };
}

export function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export interface ListOptions {
  filter: Filter;
  direct: 'any' | 'tier1' | 'tier2plus';
  sort: 'score' | 'age' | 'pay' | 'confidence' | 'targets';
}

export function listJobs(db: Db, opts: ListOptions): { items: JobListItem[]; counts: Record<Filter, number> } {
  const all = loadItems(db);
  // Open means not blocked, not rule-blocked, and not closed on LinkedIn.
  const open = (j: JobListItem) => !j.blocked && !j.rule_blocked && !j.closed;
  // The queue is the jobs with no decision yet. Progressing, not available, and not interested all leave it.
  const queued = (j: JobListItem) => open(j) && decisionOf(j) === 'undecided';
  const counts: Record<Filter, number> = {
    all: all.filter(open).length,
    undecided: all.filter(queued).length,
    good: all.filter((j) => queued(j) && j.band === 'good').length,
    review: all.filter((j) => queued(j) && j.band === 'review').length,
    progressed: all.filter((j) => decisionOf(j) === 'progressed').length,
    not_interested: all.filter((j) => decisionOf(j) === 'not_interested').length,
    not_available: all.filter((j) => decisionOf(j) === 'not_available').length,
    blocked: all.filter((j) => j.band === 'blocked').length,
    targets: all.filter((j) => queued(j) && Boolean(j.target)).length,
  };
  let items = all.filter((j) => {
    if (opts.filter === 'all') return open(j);
    if (opts.filter === 'undecided') return queued(j);
    if (opts.filter === 'good') return queued(j) && j.band === 'good';
    if (opts.filter === 'review') return queued(j) && j.band === 'review';
    if (opts.filter === 'progressed') return decisionOf(j) === 'progressed';
    if (opts.filter === 'not_interested') return decisionOf(j) === 'not_interested';
    if (opts.filter === 'not_available') return decisionOf(j) === 'not_available';
    if (opts.filter === 'targets') return queued(j) && Boolean(j.target);
    return j.band === 'blocked';
  });
  if (opts.direct === 'tier1') items = items.filter((j) => j.direct_tier === 1);
  if (opts.direct === 'tier2plus') items = items.filter((j) => j.direct_tier >= 1 && j.direct_tier <= 2);
  items.sort(sorter(opts.sort));
  return { items, counts };
}

function sorter(sort: ListOptions['sort']): (a: JobListItem, b: JobListItem) => number {
  const confRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  return (a, b) => {
    if (sort === 'targets') return Number(Boolean(b.target)) - Number(Boolean(a.target)) || (b.score ?? -1) - (a.score ?? -1) || a.id - b.id;
    if (sort === 'score') return (b.score ?? -1) - (a.score ?? -1) || a.id - b.id;
    if (sort === 'age') return Date.parse(b.posted_at ?? '0') - Date.parse(a.posted_at ?? '0') || a.id - b.id;
    if (sort === 'pay') return (b.pay?.max ?? -1) - (a.pay?.max ?? -1) || a.id - b.id;
    return (confRank[b.confidence ?? ''] ?? 0) - (confRank[a.confidence ?? ''] ?? 0) || a.id - b.id;
  };
}

export function jobDetail(db: Db, jobId: number): Record<string, unknown> | null {
  const row = loadJobRows(db).find((r) => r.id === jobId);
  if (!row) return null;
  const item = toItem(db, row, channelMap(db).get(jobId) ?? []);
  const runId = row.run_id;
  const factors = runId
    ? (db.prepare(`SELECT factor, ai_value, points, max, evidence_excerpt, source_field, confidence FROM score_factors
        WHERE score_run_id = ? AND factor != 'Hard negative' ORDER BY id`).all(runId) as unknown as Array<Record<string, unknown>>)
    : [];
  const hardNegatives = runId
    ? (db.prepare(`SELECT ai_value AS quote, source_field AS field FROM score_factors WHERE score_run_id = ? AND factor = 'Hard negative'`).all(runId) as Array<Record<string, unknown>>)
    : [];
  const sources = db
    .prepare(
      `SELECT sp.id, sp.url, sp.title, sp.company, sp.location, sp.alert_received_at, sp.message_id, sp.thread_id,
              js.match_type, js.match_reason,
              (SELECT COUNT(*) FROM posting_observations po WHERE po.posting_id = sp.id) AS observations
       FROM job_sources js JOIN source_postings sp ON sp.id = js.posting_id
       WHERE js.job_id = ? AND js.split_at IS NULL ORDER BY sp.alert_received_at DESC`,
    )
    .all(jobId) as Array<Record<string, unknown>>;
  const weak = weakMatchesFor(db, jobId);
  const events = db
    .prepare('SELECT type, payload, created_at FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 20')
    .all(jobId) as Array<{ type: string; payload: string; created_at: string }>;
  const hasDescription = (db.prepare('SELECT COUNT(*) AS n FROM job_descriptions WHERE job_id = ?').get(jobId) as { n: number }).n > 0;
  const penalties = runId
    ? (db.prepare(`SELECT factor, points, evidence_excerpt FROM score_factors WHERE score_run_id = ? AND max = 0 AND factor != 'Hard negative'`).all(runId) as Array<Record<string, unknown>>)
    : [];
  return {
    ...item,
    canonical_url: row.canonical_url,
    score_version: row.weight_version,
    scored_at: row.scored_at,
    factors,
    penalties,
    hard_negatives: hardNegatives,
    rule_block_evidence: parseList(row.rule_block_evidence),
    sources,
    weak_matches: weak,
    has_description: hasDescription,
    events: events.map((e) => ({ type: e.type, created_at: e.created_at, payload: safeJson(e.payload) })),
    reason_tags: parseList(row.verdict_tags),
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

export function stats(db: Db, lastRefreshAt: string | null): { new_since_refresh: number; good_fit: number; applied: number } {
  const { items } = listJobs(db, { filter: 'all', direct: 'any', sort: 'score' });
  const all = items;
  const every = loadItems(db);
  const newSince = lastRefreshAt ? every.filter((j) => j.first_seen > lastRefreshAt && !j.blocked && !j.rule_blocked).length : all.length;
  return {
    new_since_refresh: newSince,
    good_fit: every.filter((j) => j.band === 'good').length,
    applied: every.filter((j) => j.applied && !j.blocked && !j.rule_blocked).length,
  };
}
