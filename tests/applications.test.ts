import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { createApplication, updateApplicationStatus } from '../src/server/applications.ts';
import { listJobs } from '../src/server/jobs/read.ts';
import { fixtureMessages } from './support/fixtures.ts';

const NOW = '2026-10-28T20:00:00.000Z';
const LATER = '2026-10-29T09:00:00.000Z';

function oneJob(): { db: Db; jobId: number } {
  const db = openDatabase(':memory:');
  migrate(db);
  const [posting] = parseLinkedInAlert(fixtureMessages('single-job-posted-on')[0]!).postings;
  assert.ok(posting);
  upsertPosting(db, posting, NOW, 'linkedin-alert-v1');
  groupNewPostings(db, {}, NOW);
  const job = db.prepare('SELECT id, title, company FROM jobs ORDER BY id LIMIT 1').get() as { id: number; title: string; company: string };
  return { db, jobId: job.id };
}

function progressed(db: Db, jobId: number, status: 'saved' | 'applied') {
  const job = db.prepare('SELECT title, company FROM jobs WHERE id = ?').get(jobId) as { title: string; company: string };
  return createApplication(db, { company: job.company, title: job.title, status }, 'progress', { jobId, nowIso: NOW });
}

test('a progressed job is In Analysis, not Applied, and is left out of the Applied filter and count', () => {
  const { db, jobId } = oneJob();
  progressed(db, jobId, 'saved');
  const item = listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).items[0]!;
  assert.equal(item.applied, null);
  assert.ok(item.in_analysis);
  assert.equal(listJobs(db, { filter: 'applied', direct: 'any', sort: 'score' }).items.length, 0);
  assert.equal(listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).counts.applied, 0);
  db.close();
});

test('an application past Saved counts as Applied and keeps its date', () => {
  const { db, jobId } = oneJob();
  const appId = progressed(db, jobId, 'saved');
  updateApplicationStatus(db, appId, 'applied', null, LATER);
  const item = listJobs(db, { filter: 'applied', direct: 'any', sort: 'score' }).items[0]!;
  assert.ok(item.applied);
  assert.equal(item.in_analysis, null);
  assert.equal(item.applied.date, LATER, 'date recorded on first applied status');
  updateApplicationStatus(db, appId, 'interviewing', null, '2026-11-02T09:00:00.000Z');
  const row = db.prepare('SELECT applied_at FROM applications WHERE id = ?').get(appId) as { applied_at: string };
  assert.equal(row.applied_at, LATER, 'a later status change does not overwrite the date');
  db.close();
});

test('moving back to Saved does not clear the recorded date', () => {
  const { db, jobId } = oneJob();
  const appId = progressed(db, jobId, 'saved');
  updateApplicationStatus(db, appId, 'applied', null, LATER);
  updateApplicationStatus(db, appId, 'saved', null, '2026-11-03T09:00:00.000Z');
  const row = db.prepare('SELECT status, applied_at FROM applications WHERE id = ?').get(appId) as { status: string; applied_at: string };
  assert.equal(row.status, 'saved');
  assert.equal(row.applied_at, LATER);
  db.close();
});
