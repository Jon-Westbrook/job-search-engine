import { existsSync, readFileSync } from 'node:fs';
import type { Db } from '../db/index.ts';
import type { Logger } from '../log.ts';
import { htmlToText } from '../gog/gmail.ts';
import { guardedFetch } from '../net/guard.ts';
import { descriptionFingerprint } from '../jobs/actions.ts';
import type { ParsedPosting } from './linkedin.ts';
import { upsertPosting, type UpsertOutcome } from './store.ts';

// Public company job feeds. Read only, run on Refresh only, and filtered to the accepted
// geography before anything is stored. A feed posting has a real posted date and a full
// description, so it does not depend on an alert or a pasted description.

export const FEED_PARSER_VERSION = 'greenhouse-v1';
const MIN_DESCRIPTION = 40;

export interface FeedConfig {
  id: string;
  provider: 'greenhouse';
  board: string;
  label: string;
  enabled: boolean;
}

export function loadFeeds(path: string): FeedConfig[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { feeds?: unknown };
  if (!Array.isArray(raw.feeds)) throw new Error(`${path}: "feeds" must be a list`);
  return raw.feeds.map((item, i) => {
    const f = item as Partial<FeedConfig>;
    const where = `${path} feed ${i + 1}`;
    if (typeof f.id !== 'string' || !f.id) throw new Error(`${where} needs an id`);
    if (f.provider !== 'greenhouse') throw new Error(`${where} provider must be "greenhouse"`);
    if (typeof f.board !== 'string' || !/^[a-z0-9_-]+$/i.test(f.board)) throw new Error(`${where} board must be a plain token`);
    if (typeof f.label !== 'string' || !f.label.trim()) throw new Error(`${where} needs a label`);
    return { id: f.id, provider: 'greenhouse', board: f.board, label: f.label.trim(), enabled: f.enabled !== false };
  });
}

export function inGeography(location: string, accepted: string[]): boolean {
  const loc = location.toLowerCase();
  return accepted.some((term) => term && loc.includes(term.toLowerCase()));
}

// Greenhouse sends the description as escaped HTML. Unescape it, then strip the tags.
function descriptionOf(content: unknown): string {
  if (typeof content !== 'string') return '';
  const unescaped = content
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
  return htmlToText(unescaped).replace(/\n{3,}/g, '\n\n').trim();
}

export interface FeedJob {
  posting: ParsedPosting;
  description: string;
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
    const sourceId = `${feed.board}:${raw.id}`;
    const messageId = `feed:greenhouse:${sourceId}`;
    jobs.push({
      posting: {
        provider: 'greenhouse',
        sourceId,
        messageId,
        threadId: messageId,
        url: String(raw.absolute_url).split('?')[0]!,
        title: raw.title,
        company: feed.label,
        location,
        arrangement: /remote/i.test(location) ? 'remote' : null,
        postedAt: raw.first_published ?? null,
        postedPrecision: raw.first_published ? 'date' : null,
        alertReceivedAt: fetchedAt,
        pay: null,
        applicantCount: null,
        easyApply: false,
        connectionHint: {},
        rawFields: { subject: feed.label, flags: [], payText: null, postedText: null },
      },
      description: descriptionOf(raw.content),
    });
  }
  return { jobs, seen: list.length };
}

export function feedUrl(board: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
}

export interface FeedRunSummary {
  feeds: number;
  seen: number;
  kept: number;
  inserted: number;
  updated: number;
  unchanged: number;
  errors: Array<{ feed: string; error: string }>;
}

export interface FeedRun {
  summary: FeedRunSummary;
  attachments: Array<{ postingId: number; text: string }>;
}

type Fetcher = (url: string) => Promise<Response>;

// Stores each kept posting. Feed postings never reopen a closed job: a company page that still
// lists a job says nothing about the LinkedIn listing the owner closed.
export async function runFeeds(
  db: Db,
  feeds: FeedConfig[],
  accepted: string[],
  logger: Logger,
  nowIso: string,
  fetcher: Fetcher = (url) => guardedFetch(url, { headers: { accept: 'application/json' } }),
): Promise<FeedRun> {
  const summary: FeedRunSummary = { feeds: 0, seen: 0, kept: 0, inserted: 0, updated: 0, unchanged: 0, errors: [] };
  const attachments: FeedRun['attachments'] = [];
  for (const feed of feeds.filter((f) => f.enabled)) {
    summary.feeds += 1;
    try {
      const res = await fetcher(feedUrl(feed.board));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseGreenhouseBoard(await res.json(), feed, accepted, nowIso);
      summary.seen += parsed.seen;
      for (const job of parsed.jobs) {
        const { outcome, postingId } = upsertPosting(db, job.posting, nowIso, FEED_PARSER_VERSION);
        summary[outcome as UpsertOutcome] += 1;
        summary.kept += 1;
        if (job.description.length >= MIN_DESCRIPTION) attachments.push({ postingId, text: job.description });
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
