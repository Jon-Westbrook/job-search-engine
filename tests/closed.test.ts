import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { closeJob, reopenIfRelisted, reopenJob } from '../src/server/jobs/actions.ts';
import { listJobs } from '../src/server/jobs/read.ts';
import { fixtureMessages } from './support/fixtures.ts';

const NOW = '2026-10-28T20:00:00.000Z';

function freshDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function ingestFirst(db: Db) {
  const msg = fixtureMessages('single-job-posted-on')[0]!;
  const [posting] = parseLinkedInAlert(msg).postings;
  assert.ok(posting);
  const { postingId } = upsertPosting(db, posting, NOW, 'linkedin-alert-v1');
  groupNewPostings(db, {}, NOW);
  const job = db.prepare('SELECT id FROM jobs ORDER BY id LIMIT 1').get() as { id: number };
  return { posting, postingId, jobId: job.id };
}

test('a closed job leaves All and shows under Closed, with its history kept', () => {
  const db = freshDb();
  const { jobId } = ingestFirst(db);
  assert.equal(listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).items.length, 1);
  closeJob(db, jobId, '', NOW);
  const after = listJobs(db, { filter: 'all', direct: 'any', sort: 'score' });
  assert.equal(after.items.length, 0);
  assert.equal(after.counts.closed, 1);
  const closed = listJobs(db, { filter: 'closed', direct: 'any', sort: 'score' });
  assert.equal(closed.items.length, 1);
  assert.match(closed.items[0]?.closed?.reason ?? '', /No longer accepting/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE job_id = ? AND type = 'closed'").get(jobId) as { n: number }).n, 1);
  db.close();
});

test('a re-read of an old alert does not reopen a closed job; a newer alert does', () => {
  const db = freshDb();
  const { posting, postingId, jobId } = ingestFirst(db);
  closeJob(db, jobId, 'closed', NOW);
  reopenIfRelisted(db, postingId, '2026-10-01T00:00:00.000Z', '2026-10-28T21:00:00.000Z');
  assert.ok((db.prepare('SELECT closed_at FROM jobs WHERE id = ?').get(jobId) as { closed_at: string | null }).closed_at, 'still closed');
  reopenIfRelisted(db, postingId, '2026-10-29T09:00:00.000Z', '2026-10-29T09:05:00.000Z');
  assert.equal((db.prepare('SELECT closed_at FROM jobs WHERE id = ?').get(jobId) as { closed_at: string | null }).closed_at, null, 'reopened');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE job_id = ? AND type = 'reopened'").get(jobId) as { n: number }).n, 1);
  assert.equal(posting.sourceId.length > 0, true);
  db.close();
});

test('closing twice or reopening an open job is refused', () => {
  const db = freshDb();
  const { jobId } = ingestFirst(db);
  assert.throws(() => reopenJob(db, jobId, NOW), /not closed/);
  closeJob(db, jobId, '', NOW);
  assert.throws(() => closeJob(db, jobId, '', NOW), /already closed/);
  db.close();
});

test('the job event log still refuses edits after the table rebuild', () => {
  const db = freshDb();
  const { jobId } = ingestFirst(db);
  closeJob(db, jobId, '', NOW);
  assert.throws(() => db.exec("UPDATE job_events SET type = 'merged'"), /append-only/);
  assert.throws(() => db.exec('DELETE FROM job_events'), /append-only/);
  db.close();
});
