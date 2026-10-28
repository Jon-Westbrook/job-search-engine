import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { groupNewPostings, weakMatchesFor } from '../src/server/grouping.ts';
import { blockJob, groupPostingInto, mergeJobs, overrideBlock, setDescription, setVerdict, splitPosting, undoBlock, ActionError } from '../src/server/jobs/actions.ts';
import { findApplicationMatch, createApplication, progressJob, ProgressBlocked } from '../src/server/applications.ts';
import { normalizeCompany, normalizeTitle } from '../src/server/normalize/keys.ts';
import { fixtureMessages } from './support/fixtures.ts';

const NOW = '2026-10-28T20:00:00.000Z';

function freshDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function ingest(db: Db, name: string, nowIso = NOW): number {
  let n = 0;
  for (const msg of fixtureMessages(name)) {
    for (const p of parseLinkedInAlert(msg).postings) {
      upsertPosting(db, p, nowIso, 'linkedin-alert-v1');
      n++;
    }
  }
  return n;
}

function count(db: Db, sql: string, ...args: Array<string | number>): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

test('an exact duplicate across two alerts is one posting with two observations and one job', () => {
  const db = freshDb();
  ingest(db, 'dup-exact-a');
  ingest(db, 'dup-exact-b');
  const sharedId = '4483690435';
  const posting = db.prepare('SELECT id FROM source_postings WHERE source_id = ?').get(sharedId) as { id: number };
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM posting_observations WHERE posting_id = ?', posting.id), 2);
  groupNewPostings(db, {}, NOW);
  const jobs = count(db, 'SELECT COUNT(*) AS n FROM jobs');
  const postings = count(db, 'SELECT COUNT(*) AS n FROM source_postings');
  assert.equal(jobs, postings, 'one job per listing, never one per alert');
  groupNewPostings(db, {}, NOW);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM jobs'), jobs, 'grouping is idempotent');
  db.close();
});

test('weak matches (same company, similar title, different listing) stay separate and show a warning', () => {
  const db = freshDb();
  ingest(db, 'dup-weak-a');
  ingest(db, 'dup-weak-b');
  groupNewPostings(db, {}, NOW);
  const deloitte = db.prepare(`SELECT id FROM jobs WHERE company_key = 'deloitte' AND title_key = 'associate director applied ai engineering' LIMIT 1`).get() as { id: number } | undefined;
  assert.ok(deloitte, 'Deloitte listing is a job');
  const warnings = weakMatchesFor(db, deloitte.id);
  assert.ok(warnings.length >= 1, 'a similar listing is reported');
  assert.ok(warnings.every((w) => w.jobId !== deloitte.id));
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM jobs WHERE company_key = 'deloitte' AND title_key = 'associate director applied ai engineering'`) >= 2, true, 'not merged');
  db.close();
});

test('a pasted description that matches another job on company, title, location, and text merges them (strong)', () => {
  const db = freshDb();
  ingest(db, 'digest-with-pay');
  const [first] = parseLinkedInAlert(fixtureMessages('digest-with-pay')[0]!).postings;
  assert.ok(first, 'a posting to clone');
  // A second listing with the same company, title, and location, under its own job ID.
  upsertPosting(db, { ...first, sourceId: '9900000001', url: 'https://www.linkedin.com/jobs/view/9900000001/' }, NOW, 'linkedin-alert-v1');
  groupNewPostings(db, {}, NOW);
  const twins = db.prepare('SELECT id FROM jobs WHERE company = ? AND title = ? ORDER BY id').all(first.company, first.title) as Array<{ id: number }>;
  assert.equal(twins.length, 2, 'two separate jobs before the description');
  const [a, b] = twins as [{ id: number }, { id: number }];
  const text = 'We are hiring a design engineer to build the design system and prototypes for our product teams in New York.';
  setDescription(db, a.id, text, NOW);
  const result = setDescription(db, b.id, text, NOW);
  // The job that receives the second paste survives. The other job is emptied and marked merged.
  assert.deepEqual(result.merged, [a.id]);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM job_sources WHERE job_id = ? AND split_at IS NULL', b.id), 2, 'both listings sit under one job');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM job_sources WHERE job_id = ? AND split_at IS NULL', a.id), 0, 'the other job is empty');
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM job_events WHERE job_id = ? AND type = 'merged'`, a.id), 1);
  db.close();
});

test('a block applies to one job, a grouped re-alert inherits it, and a new listing does not', () => {
  const db = freshDb();
  ingest(db, 'dup-exact-a');
  groupNewPostings(db, {}, NOW);
  const jobId = (db.prepare('SELECT id FROM jobs ORDER BY id LIMIT 1').get() as { id: number }).id;
  blockJob(db, jobId, 'Not interested in this company', NOW);
  assert.equal((db.prepare('SELECT block_scope FROM jobs WHERE id = ?').get(jobId) as { block_scope: string }).block_scope, 'job');

  // A re-alert of the same listing joins the same job, so it stays blocked.
  ingest(db, 'dup-exact-b', '2026-10-28T21:00:00.000Z');
  groupNewPostings(db, {}, '2026-10-28T21:00:00.000Z');
  assert.equal((db.prepare('SELECT blocked_at FROM jobs WHERE id = ?').get(jobId) as { blocked_at: string | null }).blocked_at !== null, true);

  // A different listing from a weak-match company is a new job and is not blocked.
  ingest(db, 'dup-weak-a', '2026-10-28T21:00:00.000Z');
  groupNewPostings(db, {}, '2026-10-28T21:00:00.000Z');
  const other = db.prepare('SELECT blocked_at FROM jobs WHERE id <> ?').all(jobId) as Array<{ blocked_at: string | null }>;
  assert.ok(other.length > 0 && other.every((j) => j.blocked_at === null), 'other listings are not blocked');
  db.close();
});

test('undo works within five seconds, and after that the block needs Override and review', () => {
  const db = freshDb();
  ingest(db, 'dup-exact-a');
  groupNewPostings(db, {}, NOW);
  const jobId = (db.prepare('SELECT id FROM jobs ORDER BY id LIMIT 1').get() as { id: number }).id;
  blockJob(db, jobId, 'Wrong location', NOW);
  undoBlock(db, jobId, '2026-10-28T20:00:03.000Z');
  assert.equal((db.prepare('SELECT blocked_at FROM jobs WHERE id = ?').get(jobId) as { blocked_at: string | null }).blocked_at, null);

  blockJob(db, jobId, 'Wrong location', NOW);
  assert.throws(() => undoBlock(db, jobId, '2026-10-28T20:00:09.000Z'), (e: unknown) => e instanceof ActionError && /Override and review/.test(e.message));
  assert.throws(() => overrideBlock(db, jobId, '', NOW), /needs a reason/);
  overrideBlock(db, jobId, 'Changed my mind after the recruiter call', '2026-10-28T20:05:00.000Z');
  assert.equal((db.prepare('SELECT blocked_at FROM jobs WHERE id = ?').get(jobId) as { blocked_at: string | null }).blocked_at, null);
  db.close();
});

test('split moves one listing out and records the event; a single-listing job cannot be split', () => {
  const db = freshDb();
  ingest(db, 'dup-weak-a');
  groupNewPostings(db, {}, NOW);
  const jobs = db.prepare('SELECT id FROM jobs ORDER BY id').all() as Array<{ id: number }>;
  const first = jobs[0]?.id ?? 0;
  const second = jobs[1]?.id ?? 0;
  const posting = db.prepare('SELECT posting_id FROM job_sources WHERE job_id = ? AND split_at IS NULL').get(first) as { posting_id: number };
  groupPostingInto(db, second, posting.posting_id, 'they are the same role', {}, NOW);
  const newJob = splitPosting(db, second, posting.posting_id, {}, '2026-10-28T20:10:00.000Z');
  assert.ok(newJob !== second);
  assert.throws(() => splitPosting(db, newJob, posting.posting_id, {}, NOW), /cannot be split|not part/);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM job_events WHERE type = 'split' AND job_id = ?`, second), 1);
  db.close();
});

test('verdicts are feedback only: they never touch a score or weight', () => {
  const db = freshDb();
  ingest(db, 'dup-exact-a');
  groupNewPostings(db, {}, NOW);
  const jobId = (db.prepare('SELECT id FROM jobs ORDER BY id LIMIT 1').get() as { id: number }).id;
  setVerdict(db, jobId, 'good', ['Role fit', 'Pay'], 'Strong fit', NOW);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM feedback WHERE job_id = ?', jobId), 1);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM score_runs'), 0);
  assert.throws(() => setVerdict(db, jobId, 'great', [], null, NOW), /good, maybe, or bad/);
  assert.throws(() => setVerdict(db, jobId, 'good', ['Made up'], null, NOW), /Unknown reason tag/);
  db.close();
});

test('an application with the same company and title is found, and Progress needs a reason', () => {
  const db = freshDb();
  ingest(db, 'digest-with-pay');
  groupNewPostings(db, {}, NOW);
  const job = db.prepare(`SELECT id, canonical_url, company_key, title_key, title, company FROM jobs WHERE company_key = ? LIMIT 1`).get(normalizeCompany('Lunon')!) as
    | { id: number; canonical_url: string; company_key: string; title_key: string; title: string; company: string }
    | undefined;
  assert.ok(job, 'Lunon job exists');
  createApplication(db, { company: 'Lunon Ltd', title: 'Forward Deployed AI Engineer', status: 'applied', applied_at: '2026-09-14' }, 'manual', { nowIso: NOW });
  const match = findApplicationMatch(db, job);
  assert.equal(match?.reason, 'same company and title');
  assert.equal(match?.applied_at, '2026-09-14');
  assert.throws(() => progressJob(db, job, { nowIso: NOW }), ProgressBlocked);
  const ok = progressJob(db, job, { reason: 'Different team and a referral', nowIso: NOW });
  assert.ok(ok.applicationId > 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM application_events WHERE type = 'duplicate_reason'`), 1);
  assert.equal((db.prepare('SELECT stage FROM jobs WHERE id = ?').get(job.id) as { stage: string }).stage, 'analysis');
  db.close();
});

test('the application match checks the job link first, then the URL', () => {
  const db = freshDb();
  ingest(db, 'digest-with-pay');
  groupNewPostings(db, {}, NOW);
  const job = db.prepare('SELECT id, canonical_url, company_key, title_key FROM jobs ORDER BY id LIMIT 1').get() as { id: number; canonical_url: string; company_key: string; title_key: string };
  createApplication(db, { company: 'Other Co', title: 'Other Role', source_url: job.canonical_url, status: 'saved' }, 'manual', { nowIso: NOW });
  assert.equal(findApplicationMatch(db, job)?.reason, 'same URL');

  db.close();
});

test('normalized keys are used for application matching', () => {
  assert.equal(normalizeTitle('Forward Deployed AI Engineer'), 'forward deployed ai engineer');
});
