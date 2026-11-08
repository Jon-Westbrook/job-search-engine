import { existsSync, readFileSync } from 'node:fs';
import type { Db } from '../db/index.ts';
import type { Logger } from '../log.ts';
import { htmlToText } from '../gog/gmail.ts';
import { guardedFetch } from '../net/guard.ts';
import { descriptionFingerprint } from '../jobs/actions.ts';
import type { ParsedPosting } from './linkedin.ts';
import { upsertPosting, type UpsertOutcome } from './store.ts';

// Public company job feeds. Read only, run on Refresh only, and filtered to the accepted
// geography before anything is stored. Each provider uses the public data its site publishes:
// a posting API (Greenhouse, Ashby), a site's own job list (Publicis), or the sitemap plus the
// job page's structured data (Workday). Robots rules and crawl delays are honoured.

export type FeedProvider = 'greenhouse' | 'ashby' | 'jibe' | 'workday';
export const FEED_PROVIDERS: FeedProvider[] = ['greenhouse', 'ashby', 'jibe', 'workday'];
const USER_AGENT = 'AUTOJOB-feed-reader/0.1 (personal job search, read only)';
const MIN_DESCRIPTION = 40;
const MAX_NEW_PAGES_PER_RUN = 150;
const FETCH_TIMEOUT_MS = 30_000;

export interface FeedConfig {
  id: string;
  provider: FeedProvider;
  label: string;
  enabled: boolean;
  board?: string; // greenhouse, ashby: the board token
  base?: string; // jibe: the careers site
  state?: string; // jibe: the state filter, for example "New York"
  host?: string; // workday: the tenant host
  site?: string; // workday: the career site path
  cache_hours?: number; // a feed fetched more recently than this is not fetched again
  delay_ms?: number; // pause between requests to the same site
}

export function loadFeeds(path: string): FeedConfig[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { feeds?: unknown };
  if (!Array.isArray(raw.feeds)) throw new Error(`${path}: "feeds" must be a list`);
  return raw.feeds.map((item, i) => {
    const f = item as Partial<FeedConfig>;
    const where = `${path} feed ${i + 1}`;
    if (typeof f.id !== 'string' || !f.id) throw new Error(`${where} needs an id`);
    if (!FEED_PROVIDERS.includes(f.provider as FeedProvider)) throw new Error(`${where} provider must be one of: ${FEED_PROVIDERS.join(', ')}`);
    if (typeof f.label !== 'string' || !f.label.trim()) throw new Error(`${where} needs a label`);
    const plain = (v: unknown) => typeof v === 'string' && /^[a-z0-9_.-]+$/i.test(v);
    if ((f.provider === 'greenhouse' || f.provider === 'ashby') && !plain(f.board)) throw new Error(`${where} board must be a plain token`);
    if (f.provider === 'jibe' && (typeof f.base !== 'string' || !f.base.startsWith('https://'))) throw new Error(`${where} base must be an https address`);
    if (f.provider === 'workday' && (!plain(f.host) || !plain(f.site))) throw new Error(`${where} needs a host and a site`);
    return {
      id: f.id,
      provider: f.provider as FeedProvider,
      label: f.label.trim(),
      enabled: f.enabled !== false,
      board: f.board,
      base: f.base,
      state: f.state,
      host: f.host,
      site: f.site,
      cache_hours: typeof f.cache_hours === 'number' ? f.cache_hours : undefined,
      delay_ms: typeof f.delay_ms === 'number' ? f.delay_ms : undefined,
    };
  });
}

export function inGeography(location: string, accepted: string[]): boolean {
  const loc = location.toLowerCase();
  return accepted.some((term) => term && loc.includes(term.toLowerCase()));
}

export interface FeedJob {
  posting: ParsedPosting;
  description: string;
}

type Fetcher = (url: string) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

function postingFor(feed: FeedConfig, sourceId: string, fields: Partial<ParsedPosting> & Pick<ParsedPosting, 'url' | 'title' | 'location' | 'alertReceivedAt'>, provider: 'greenhouse' | 'ashby' | 'jibe' | 'workday'): ParsedPosting {
  const messageId = `feed:${provider}:${sourceId}`;
  return {
    provider,
    sourceId,
    messageId,
    threadId: messageId,
    company: feed.label,
    arrangement: null,
    postedAt: null,
    postedPrecision: null,
    pay: null,
    applicantCount: null,
    easyApply: false,
    connectionHint: {},
    rawFields: { subject: feed.label, flags: [], payText: null, postedText: null },
    ...fields,
    url: fields.url.split('?')[0]!,
  };
}

// Feeds send descriptions as plain text or as HTML, sometimes escaped. Unescape first, then
// strip any tags, so every provider stores the same kind of text.
function plainFrom(value: unknown): string {
  if (typeof value !== 'string') return '';
  const unescaped = value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  const text = /<[a-z][\s\S]*>/i.test(unescaped) ? htmlToText(unescaped) : unescaped;
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  first_published?: string | null;
  content?: string;
}

// Keeps only jobs in the accepted geography. An empty geography keeps nothing, so a missing
// setting never pulls in a whole global board.
export function parseGreenhouseBoard(body: unknown, feed: FeedConfig, accepted: string[], fetchedAt: string): { jobs: FeedJob[]; seen: number } {
  const list = (body as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error(`${feed.id}: the feed has no jobs list`);
  const jobs: FeedJob[] = [];
  for (const raw of list as GreenhouseJob[]) {
    const location = raw.location?.name ?? '';
    if (!inGeography(location, accepted)) continue;
    jobs.push({
      posting: postingFor(feed, `${feed.board}:${raw.id}`, {
        url: String(raw.absolute_url),
        title: raw.title,
        location,
        arrangement: /remote/i.test(location) ? 'remote' : null,
        postedAt: raw.first_published ?? null,
        postedPrecision: raw.first_published ? 'date' : null,
        alertReceivedAt: fetchedAt,
      }, 'greenhouse'),
      description: plainFrom(raw.content),
    });
  }
  return { jobs, seen: list.length };
}

export function feedUrl(board: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
}

// Ashby's public posting API. Listed jobs only, filtered by location in code.
export function parseAshbyBoard(body: unknown, feed: FeedConfig, accepted: string[], fetchedAt: string): { jobs: FeedJob[]; seen: number } {
  const list = (body as { jobs?: unknown })?.jobs;
  if (!Array.isArray(list)) throw new Error(`${feed.id}: the feed has no jobs list`);
  const jobs: FeedJob[] = [];
  for (const raw of list as Array<Record<string, unknown>>) {
    if (String(raw.isListed).toLowerCase() !== 'true') continue;
    const location = String(raw.location ?? '');
    if (!inGeography(location, accepted)) continue;
    const workplace = String(raw.workplaceType ?? '').toLowerCase();
    jobs.push({
      posting: postingFor(feed, `${feed.board}:${String(raw.id)}`, {
        url: String(raw.jobUrl ?? raw.applyUrl ?? ''),
        title: String(raw.title ?? ''),
        location,
        arrangement: workplace === 'onsite' || workplace === 'hybrid' || workplace === 'remote' ? workplace : null,
        postedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : null,
        postedPrecision: typeof raw.publishedAt === 'string' ? 'date' : null,
        alertReceivedAt: fetchedAt,
      }, 'ashby'),
      description: plainFrom(raw.descriptionPlain ?? raw.descriptionHtml),
    });
  }
  return { jobs, seen: list.length };
}

// Publicis (Jibe) job list. Its state filter returns the jobs in that state.
export function parseJibePage(body: unknown, feed: FeedConfig, accepted: string[], fetchedAt: string): { jobs: FeedJob[]; seen: number; total: number } {
  const b = body as { jobs?: unknown; totalCount?: unknown };
  const list = Array.isArray(b?.jobs) ? (b.jobs as Array<{ data?: Record<string, unknown> } & Record<string, unknown>>) : [];
  const jobs: FeedJob[] = [];
  for (const item of list) {
    const r = (item.data ?? item) as Record<string, unknown>;
    const location = [r.city, r.state].filter((x) => typeof x === 'string' && x).join(', ');
    if (!inGeography(location, accepted) || !r.req_id) continue;
    const description = [plainFrom(r.description), plainFrom(r.responsibilities), plainFrom(r.qualifications)].filter(Boolean).join('\n\n');
    jobs.push({
      posting: postingFor(feed, String(r.req_id), {
        url: String(r.apply_url ?? `${feed.base}/job/${String(r.req_id)}`),
        title: String(r.title ?? ''),
        location,
        postedAt: typeof r.posted_date === 'string' ? r.posted_date : null,
        postedPrecision: typeof r.posted_date === 'string' ? 'date' : null,
        alertReceivedAt: fetchedAt,
      }, 'jibe'),
      description,
    });
  }
  return { jobs, seen: list.length, total: typeof b?.totalCount === 'number' ? b.totalCount : 0 };
}

// Workday sitemap: the job links for a career site. Language variants are collapsed to one job.
export function parseWorkdaySitemap(xml: string, host: string, site: string): Array<{ url: string; sourceId: string; locationToken: string }> {
  const prefix = `https://${host}/${site}/job/`;
  const seen = new Map<string, { url: string; sourceId: string; locationToken: string }>();
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = match[1]!.trim();
    if (!url.startsWith(prefix)) continue;
    const rest = url.slice(prefix.length).split('/');
    const reqMatch = rest[rest.length - 1]!.match(/_([A-Za-z0-9-]+)$/);
    if (!reqMatch || rest.length < 2) continue;
    const sourceId = `${site}:${reqMatch[1]}`;
    if (!seen.has(sourceId)) seen.set(sourceId, { url, sourceId, locationToken: rest[0]! });
  }
  return [...seen.values()];
}

// The location token in a Workday link reads "United-States---New-York---New-York-City".
export function workdayLocationText(token: string): string {
  return decodeURIComponent(token).replace(/---/g, ', ').replace(/-/g, ' ');
}

// A Workday job page carries a JobPosting block with the date and the description.
export function parseWorkdayJobPage(html: string, link: { url: string; sourceId: string; locationToken: string }, feed: FeedConfig, fetchedAt: string): FeedJob | null {
  const blocks = [...html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  for (const block of blocks) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(block) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (data['@type'] !== 'JobPosting') continue;
    const datePosted = typeof data.datePosted === 'string' ? data.datePosted.slice(0, 10) : null;
    return {
      posting: postingFor(feed, link.sourceId, {
        url: link.url,
        title: plainFrom(data.title),
        location: workdayLocationText(link.locationToken),
        arrangement: /remote/i.test(String(data.jobLocationType ?? '')) ? 'remote' : null,
        postedAt: datePosted,
        postedPrecision: datePosted ? 'date' : null,
        alertReceivedAt: fetchedAt,
      }, 'workday'),
      description: plainFrom(data.description),
    };
  }
  return null;
}

export interface FeedRunSummary {
  feeds: number;
  seen: number;
  kept: number;
  inserted: number;
  updated: number;
  unchanged: number;
  cached: number;
  errors: Array<{ feed: string; error: string }>;
}

export interface FeedRun {
  summary: FeedRunSummary;
  attachments: Array<{ postingId: number; text: string }>;
}

async function getJson(fetcher: Fetcher, url: string): Promise<unknown> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getText(fetcher: Fetcher, url: string): Promise<string> {
  const res = await fetcher(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

interface Context {
  db: Db;
  accepted: string[];
  nowIso: string;
  fetcher: Fetcher;
  sleep: Sleep;
  feed: FeedConfig;
}

// Each provider returns the jobs it keeps. Descriptions travel with the job for the attach step.
async function fetchFeed(ctx: Context): Promise<{ jobs: FeedJob[]; seen: number }> {
  const { feed, accepted, nowIso, fetcher, sleep } = ctx;
  if (feed.provider === 'greenhouse') {
    return parseGreenhouseBoard(await getJson(fetcher, feedUrl(feed.board!)), feed, accepted, nowIso);
  }
  if (feed.provider === 'ashby') {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(feed.board!)}?includeCompensation=true`;
    return parseAshbyBoard(await getJson(fetcher, url), feed, accepted, nowIso);
  }
  if (feed.provider === 'jibe') {
    const jobs: FeedJob[] = [];
    let seen = 0;
    for (let page = 1; page <= 200; page++) {
      const state = feed.state ? `&state=${encodeURIComponent(feed.state)}` : '';
      const parsed = parseJibePage(await getJson(fetcher, `${feed.base}/api/jobs?page=${page}${state}`), feed, accepted, nowIso);
      jobs.push(...parsed.jobs);
      seen += parsed.seen;
      if (parsed.seen === 0 || page * parsed.seen >= parsed.total) break;
      await sleep(feed.delay_ms ?? 5000);
    }
    return { jobs, seen };
  }
  // Workday: the sitemap lists the links. Only New York links are read, and only new ones.
  const links = parseWorkdaySitemap(await getText(fetcher, `https://${feed.host}/${feed.site}/siteMap.xml`), feed.host!, feed.site!);
  const inArea = links.filter((l) => inGeography(workdayLocationText(l.locationToken), accepted));
  const jobs: FeedJob[] = [];
  let pages = 0;
  for (const link of inArea) {
    const known = ctx.db.prepare("SELECT 1 FROM source_postings WHERE provider = 'workday' AND source_id = ?").get(link.sourceId);
    if (known) continue;
    if (pages >= MAX_NEW_PAGES_PER_RUN) break;
    pages += 1;
    await sleep(feed.delay_ms ?? 1000);
    const job = parseWorkdayJobPage(await getText(fetcher, link.url), link, feed, nowIso);
    if (job) jobs.push(job);
  }
  return { jobs, seen: links.length };
}

// Stores each kept posting. Feed postings never reopen a closed job: a company page that still
// lists a job says nothing about the LinkedIn listing the owner closed.
export async function runFeeds(
  db: Db,
  feeds: FeedConfig[],
  accepted: string[],
  logger: Logger,
  nowIso: string,
  fetcher: Fetcher = (url) =>
    guardedFetch(url, { headers: { accept: '*/*', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
  sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onFeed?: (done: number, total: number) => void,
): Promise<FeedRun> {
  const summary: FeedRunSummary = { feeds: 0, seen: 0, kept: 0, inserted: 0, updated: 0, unchanged: 0, cached: 0, errors: [] };
  const attachments: FeedRun['attachments'] = [];
  const enabled = feeds.filter((f) => f.enabled);
  for (const [index, feed] of enabled.entries()) {
    onFeed?.(index, enabled.length);
    summary.feeds += 1;
    if (feed.cache_hours && feed.cache_hours > 0) {
      const last = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(`feed_fetched:${feed.id}`) as { value: string } | undefined;
      if (last && Date.parse(nowIso) - Date.parse(last.value) < feed.cache_hours * 3_600_000) {
        summary.cached += 1;
        continue;
      }
    }
    try {
      const fetched = await fetchFeed({ db, accepted, nowIso, fetcher, sleep, feed });
      summary.seen += fetched.seen;
      for (const job of fetched.jobs) {
        const { outcome, postingId } = upsertPosting(db, job.posting, nowIso, `${feed.provider}-v1`);
        summary[outcome as UpsertOutcome] += 1;
        summary.kept += 1;
        if (job.description.length >= MIN_DESCRIPTION) attachments.push({ postingId, text: job.description });
      }
      if (feed.cache_hours) {
        db.prepare(
          `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(`feed_fetched:${feed.id}`, nowIso, nowIso);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'feed failed';
      summary.errors.push({ feed: feed.id, error: message });
      logger.warn('feed failed', { feed: feed.id, error: message });
    }
  }
  return { summary, attachments };
}

// Adds a feed description to the job behind each kept posting. Only a new text is added.
export function attachFeedDescriptions(db: Db, attachments: FeedRun['attachments'], nowIso: string): number {
  let added = 0;
  for (const { postingId, text } of attachments) {
    const jobs = db
      .prepare('SELECT job_id FROM job_sources WHERE posting_id = ? AND split_at IS NULL')
      .all(postingId) as Array<{ job_id: number }>;
    const fingerprint = descriptionFingerprint(text);
    for (const { job_id: jobId } of jobs) {
      const known = db.prepare('SELECT 1 FROM job_descriptions WHERE job_id = ? AND fingerprint = ?').get(jobId, fingerprint);
      if (known) continue;
      db.prepare('INSERT INTO job_descriptions (job_id, text, fingerprint, source, created_at) VALUES (?, ?, ?, ?, ?)').run(jobId, text, fingerprint, 'feed', nowIso);
      db.prepare('UPDATE jobs SET description_fingerprint = ? WHERE id = ?').run(fingerprint, jobId);
      db.prepare(`INSERT INTO job_events (job_id, type, payload, created_at) VALUES (?, 'description_added', ?, ?)`).run(jobId, JSON.stringify({ fingerprint, source: 'feed' }), nowIso);
      added += 1;
    }
  }
  return added;
}
