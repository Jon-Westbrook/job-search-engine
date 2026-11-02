import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { syncTargets } from '../src/server/lists.ts';
import { buildNetwork } from '../src/server/network.ts';
import { draftMessage } from '../src/shared/drafts.ts';
import { fixtureMessages } from './support/fixtures.ts';

const NOW = '2026-10-28T20:00:00.000Z';

function withJobs(): { db: Db; companies: string[] } {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const msg of fixtureMessages('large-digest')) {
    for (const posting of parseLinkedInAlert(msg).postings) upsertPosting(db, posting, NOW, 'linkedin-alert-v1');
  }
  groupNewPostings(db, {}, NOW);
  const rows = db.prepare('SELECT DISTINCT company FROM jobs WHERE company IS NOT NULL ORDER BY id').all() as Array<{ company: string }>;
  return { db, companies: rows.map((r) => r.company) };
}

function addContact(db: Db, name: string, company: string, relationship: string) {
  db.prepare("INSERT INTO contacts (name, company, company_key, relationship, provenance, created_at) VALUES (?, ?, lower(?), ?, 'test', ?)").run(name, company, company, relationship, NOW);
}

test('a company with a contact and an open job is ranked first, with the contact and its best job', () => {
  const { db, companies } = withJobs();
  const withJob = companies[0]!;
  addContact(db, 'Ann Friend', withJob, 'friend');
  addContact(db, 'Bo Connection', withJob, 'connection');
  const rows = buildNetwork(db);
  const top = rows[0]!;
  assert.equal(top.company, withJob);
  assert.deepEqual(top.contacts.map((c) => c.name), ['Ann Friend', 'Bo Connection'], 'friend before connection');
  assert.ok(top.jobs.length >= 1 && top.jobs.length <= 3);
  assert.ok(top.job_count >= top.jobs.length);
  assert.equal(top.best_score, top.jobs[0]!.score);
  db.close();
});

test('a contact at a company with no open job is still listed, with no jobs and sorted after', () => {
  const { db } = withJobs();
  addContact(db, 'Cy Nojobs', 'A Company Nobody Hires At', 'referral');
  const rows = buildNetwork(db);
  const row = rows.find((r) => r.company === 'A Company Nobody Hires At')!;
  assert.ok(row);
  assert.equal(row.job_count, 0);
  assert.equal(rows.indexOf(row), rows.length - 1, 'no-job companies sort last');
  db.close();
});

test('a target company is marked with its target name', () => {
  const { db, companies } = withJobs();
  const pick = companies[0]!;
  syncTargets(db, [{ name: pick }], {}, NOW);
  addContact(db, 'Di Target', pick, 'friend');
  assert.equal(buildNetwork(db).find((r) => r.company === pick)?.target, pick);
  db.close();
});

test('no contacts gives an empty network', () => {
  const { db } = withJobs();
  assert.deepEqual(buildNetwork(db), []);
  db.close();
});

test('drafts name the contact and the role, and never sign for the owner', () => {
  const withRole = draftMessage('Ann Friend', 'VML', 'Design Engineer');
  assert.match(withRole, /^Hi Ann, /);
  assert.match(withRole, /Design Engineer role at VML/);
  const general = draftMessage('Ann Friend', 'VML', null);
  assert.match(general, /roles at VML/);
});
