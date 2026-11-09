import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { decide, markApplied, type DecisionContext } from '../src/server/jobs/decisions.ts';
import { listJobs } from '../src/server/jobs/read.ts';
import { fixtureMessages } from './support/fixtures.ts';

const NOW = '2026-11-05T20:00:00.000Z';

function setup(): { db: Db; jobId: number; ctx: DecisionContext } {
  const db = openDatabase(':memory:');
  migrate(db);
  const [posting] = parseLinkedInAlert(fixtureMessages('single-job-posted-on')[0]!).postings;
  assert.ok(posting);
  upsertPosting(db, posting, NOW, 'linkedin-alert-v1');
  groupNewPostings(db, {}, NOW);
  const job = db.prepare('SELECT id FROM jobs ORDER BY id LIMIT 1').get() as { id: number };
  const ctx: DecisionContext = { db, nowIso: () => NOW, scoreVersionOf: () => null, aliases: {} };
  return { db, jobId: job.id, ctx };
}

test('Applied on a job never progressed saves it and marks it applied in one step, and a repeat changes nothing', () => {
  const { db, jobId, ctx } = setup();
  markApplied(ctx, jobId);
  const item = listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).items.find((j) => j.id === jobId)!;
  assert.ok(item.applied, 'the job shows as applied');
  const before = (db.prepare('SELECT COUNT(*) n FROM applications').get() as { n: number }).n;
  markApplied(ctx, jobId);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM applications').get() as { n: number }).n, before);
  db.close();
});

test('Not available takes a job out of every list that shows open jobs, Network included', () => {
  const { db, jobId, ctx } = setup();
  decide(ctx, jobId, 'not_available');
  assert.equal(listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).items.length, 0);
  decide(ctx, jobId, 'reopen');
  assert.equal(listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).items.length, 1);
  db.close();
});

test('Not interested takes a job out of the Inbox queue, and Bring back returns it', () => {
  const { db, jobId, ctx } = setup();
  decide(ctx, jobId, 'not_interested');
  assert.equal(listJobs(db, { filter: 'undecided', direct: 'any', sort: 'score' }).items.length, 0);
  decide(ctx, jobId, 'bring_back');
  assert.equal(listJobs(db, { filter: 'undecided', direct: 'any', sort: 'score' }).items.length, 1);
  db.close();
});
