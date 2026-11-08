import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { attachFeedDescriptions, loadFeeds, parseAshbyBoard, parseGreenhouseBoard, parseJibePage, parseWorkdayJobPage, parseWorkdaySitemap, runFeeds, workdayLocationText, type FeedConfig } from '../src/server/ingest/feeds.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { closeJob } from '../src/server/jobs/actions.ts';
import { listJobs } from '../src/server/jobs/read.ts';

const NOW = '2026-10-24T20:00:00.000Z';
const NYC = ['new york', 'brooklyn', 'nyc', 'greater new york city area'];
const body = JSON.parse(readFileSync(join(process.cwd(), 'fixtures/feeds/greenhouse-sample.json'), 'utf8')) as unknown;
const VML: FeedConfig = { id: 'greenhouse-vml', provider: 'greenhouse', board: 'example', label: 'VML', enabled: true };

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Parameters<typeof runFeeds>[3];

function fetcherFor(payload: unknown) {
  return async () => new Response(JSON.stringify(payload), { status: 200 });
}

function freshDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

test('only Greater NYC jobs are kept, with the description and posted date', () => {
  const { jobs, seen } = parseGreenhouseBoard(body, VML, NYC, NOW);
  assert.equal(seen, 3);
  assert.deepEqual(jobs.map((j) => j.posting.title), ['Design Engineer, Brand Platforms', 'Remote Product Designer']);
  const design = jobs[0]!;
  assert.equal(design.posting.provider, 'greenhouse');
  assert.equal(design.posting.company, 'VML');
  assert.equal(design.posting.postedAt, '2026-10-20T14:00:00-04:00');
  assert.equal(design.posting.postedPrecision, 'date');
  assert.match(design.description, /Build interactive brand experiences with React, TypeScript/);
  assert.doesNotMatch(design.description, /<|&lt;/);
  assert.equal(jobs[1]!.posting.arrangement, 'remote');
  assert.equal(jobs[1]!.posting.postedPrecision, null, 'no first_published means no stated date');
});

test('an empty geography keeps nothing, so a missing setting never pulls in a whole board', () => {
  assert.equal(parseGreenhouseBoard(body, VML, [], NOW).jobs.length, 0);
});

test('a bad feed entry stops loading with a clear message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feeds-'));
  const path = join(dir, 'feeds.json');
  try {
    writeFileSync(path, JSON.stringify({ feeds: [{ id: 'x', provider: 'bogus', board: 'a', label: 'A' }] }));
    assert.throws(() => loadFeeds(path), /provider must be one of/);
    writeFileSync(path, JSON.stringify({ feeds: [{ id: 'x', provider: 'greenhouse', board: 'a/b', label: 'A' }] }));
    assert.throws(() => loadFeeds(path), /board must be a plain token/);
    writeFileSync(path, JSON.stringify({ feeds: [{ id: 'x', provider: 'workday', label: 'A' }] }));
    assert.throws(() => loadFeeds(path), /needs a host and a site/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a feed run stores jobs once; a second run changes nothing', async () => {
  const db = freshDb();
  const first = await runFeeds(db, [VML], NYC, logger, NOW, fetcherFor(body));
  assert.equal(first.summary.kept, 2);
  assert.equal(first.summary.inserted, 2);
  groupNewPostings(db, {}, NOW);
  const second = await runFeeds(db, [VML], NYC, logger, NOW, fetcherFor(body));
  assert.equal(second.summary.inserted, 0);
  assert.equal(second.summary.unchanged, 2);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n, 2);
  db.close();
});

test('a failing feed is recorded and the others still run', async () => {
  const db = freshDb();
  const broken: FeedConfig = { ...VML, id: 'greenhouse-broken', board: 'broken' };
  const fetcher = async (url: string) => (url.includes('/broken/') ? new Response('nope', { status: 500 }) : new Response(JSON.stringify(body), { status: 200 }));
  const run = await runFeeds(db, [broken, VML], NYC, logger, NOW, fetcher);
  assert.equal(run.summary.errors.length, 1);
  assert.equal(run.summary.errors[0]!.feed, 'greenhouse-broken');
  assert.equal(run.summary.kept, 2, 'the good feed still stored its jobs');
  db.close();
});

test('the feed description attaches to its job, once, and a closed job is not reopened by a feed', async () => {
  const db = freshDb();
  const run = await runFeeds(db, [VML], NYC, logger, NOW, fetcherFor(body));
  groupNewPostings(db, {}, NOW);
  assert.equal(attachFeedDescriptions(db, run.attachments, NOW), 2);
  assert.equal(attachFeedDescriptions(db, run.attachments, NOW), 0, 'a repeat adds nothing');
  const source = (db.prepare("SELECT source FROM job_descriptions LIMIT 1").get() as { source: string }).source;
  assert.equal(source, 'feed');

  const job = listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).items.find((j) => j.company === 'VML')!;
  closeJob(db, job.id, '', NOW);
  // The same feed again, with a changed posted date, must not reopen the closed job.
  const changed = JSON.parse(JSON.stringify(body)) as { jobs: Array<{ first_published: string | null }> };
  changed.jobs[0]!.first_published = '2026-10-27T09:00:00-04:00';
  await runFeeds(db, [VML], NYC, logger, '2026-10-29T09:00:00.000Z', fetcherFor(changed));
  const after = db.prepare('SELECT closed_at FROM jobs WHERE id = ?').get(job.id) as { closed_at: string | null };
  assert.ok(after.closed_at, 'still closed');
  db.close();
});

const fixture = (name: string) => readFileSync(join(process.cwd(), 'fixtures/feeds', name), 'utf8');
const noSleep = async () => {};

test('Ashby keeps listed Greater NYC jobs only, with the public description and date', () => {
  const feed: FeedConfig = { id: 'ashby-x', provider: 'ashby', board: 'example', label: 'Example', enabled: true };
  const { jobs, seen } = parseAshbyBoard(JSON.parse(fixture('ashby-sample.json')), feed, NYC, NOW);
  assert.equal(seen, 3);
  assert.deepEqual(jobs.map((j) => j.posting.title), ['Forward Deployed Engineer']);
  assert.equal(jobs[0]!.posting.url, 'https://jobs.ashbyhq.com/example/a1', 'tracking query removed');
  assert.equal(jobs[0]!.posting.arrangement, 'onsite');
  assert.match(jobs[0]!.description, /customer-facing AI systems/);
});

test('Publicis keeps the New York jobs from its state-filtered list', async () => {
  const feed: FeedConfig = { id: 'jibe-x', provider: 'jibe', base: 'https://careers.example.com', state: 'New York', label: 'Publicis', enabled: true, delay_ms: 0 };
  const parsed = parseJibePage(JSON.parse(fixture('jibe-page.json')), feed, NYC, NOW);
  assert.deepEqual(parsed.jobs.map((j) => j.posting.title), ['Senior Design Engineer', 'Account Director']);
  assert.match(parsed.jobs[0]!.description, /Design systems and product engineering/);
  assert.doesNotMatch(parsed.jobs[0]!.description, /<p>/);
  const db = freshDb();
  const fetcher = async () => new Response(fixture('jibe-page.json'), { status: 200 });
  const run = await runFeeds(db, [feed], NYC, logger, NOW, fetcher, noSleep);
  assert.equal(run.summary.kept, 2);
  db.close();
});

test('Workday: the sitemap gives one link per job, and only New York links are read', () => {
  const links = parseWorkdaySitemap(fixture('workday-sitemap.xml'), 'pfizer.example.myworkdayjobs.com', 'SiteOne');
  assert.equal(links.length, 3, 'language variants collapse to one job');
  assert.equal(workdayLocationText(links[0]!.locationToken), 'United States, New York, New York City');
  assert.equal(links[0]!.sourceId, 'SiteOne:4000001-1');
});

test('Workday: the job page gives the date and the description', () => {
  const feed: FeedConfig = { id: 'wd-x', provider: 'workday', host: 'pfizer.example.myworkdayjobs.com', site: 'SiteOne', label: 'Pfizer', enabled: true };
  const link = parseWorkdaySitemap(fixture('workday-sitemap.xml'), 'pfizer.example.myworkdayjobs.com', 'SiteOne')[0]!;
  const job = parseWorkdayJobPage(fixture('workday-job.html'), link, feed, NOW);
  assert.ok(job);
  assert.equal(job.posting.postedAt, '2026-10-30');
  assert.equal(job.posting.title, 'Lead Designer');
  assert.match(job.description, /clinical brand experiences/);
  assert.doesNotMatch(job.description, /&lt;/);
});

test('Workday: a job already stored is not fetched again, and a cached feed is not fetched at all', async () => {
  const db = freshDb();
  const feed: FeedConfig = { id: 'wd-y', provider: 'workday', host: 'pfizer.example.myworkdayjobs.com', site: 'SiteOne', label: 'Pfizer', enabled: true, delay_ms: 0 };
  const requested: string[] = [];
  const fetcher = async (url: string) => {
    requested.push(url);
    if (url.endsWith('siteMap.xml')) return new Response(fixture('workday-sitemap.xml'), { status: 200 });
    return new Response(fixture('workday-job.html'), { status: 200 });
  };
  const first = await runFeeds(db, [feed], NYC, logger, NOW, fetcher, noSleep);
  assert.equal(first.summary.kept, 2, 'two New York jobs stored');
  const pagesFirst = requested.filter((u) => u.includes('/job/')).length;
  requested.length = 0;
  await runFeeds(db, [feed], NYC, logger, NOW, fetcher, noSleep);
  assert.equal(requested.filter((u) => u.includes('/job/')).length, 0, 'known jobs are not fetched again');
  assert.equal(pagesFirst, 2);
  db.close();
});

test('a feed with a cache period is not fetched again inside it', async () => {
  const db = freshDb();
  const feed: FeedConfig = { id: 'jibe-cache', provider: 'jibe', base: 'https://careers.example.com', state: 'New York', label: 'Publicis', enabled: true, cache_hours: 12, delay_ms: 0 };
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return new Response(fixture('jibe-page.json'), { status: 200 });
  };
  await runFeeds(db, [feed], NYC, logger, '2026-11-02T10:00:00.000Z', fetcher, noSleep);
  const callsAfterFirst = calls;
  const second = await runFeeds(db, [feed], NYC, logger, '2026-11-02T14:00:00.000Z', fetcher, noSleep);
  assert.equal(second.summary.cached, 1);
  assert.equal(calls, callsAfterFirst, 'no request inside the cache period');
  db.close();
});
