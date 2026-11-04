import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { listJobs } from '../src/server/jobs/read.ts';
import { buildNetwork } from '../src/server/network.ts';
import { askedFor, listOutreach, recordOutreach, updateOutreach } from '../src/server/outreach.ts';
import { syncContactsFromFile } from '../src/server/lists.ts';
import { personKey } from '../src/shared/person.ts';
import { followUpMessage, draftMessage } from '../src/shared/drafts.ts';
import { ActionError } from '../src/server/jobs/actions.ts';
import { fixtureMessages } from './support/fixtures.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SENT = '2026-11-03T15:00:00.000Z';
const DAY = 86_400_000;
const after = (days: number) => new Date(Date.parse(SENT) + days * DAY).toISOString();

// A database with one open job and one contact at the same company, loaded from the contacts file.
function setup(): { db: Db; jobId: number; key: string; contactsPath: string; dir: string } {
  const db = openDatabase(':memory:');
  migrate(db);
  const [posting] = parseLinkedInAlert(fixtureMessages('single-job-posted-on')[0]!).postings;
  assert.ok(posting);
  upsertPosting(db, posting, SENT, 'linkedin-alert-v1');
  groupNewPostings(db, {}, SENT);
  const job = db.prepare('SELECT id, company, company_key FROM jobs ORDER BY id LIMIT 1').get() as { id: number; company: string; company_key: string };
  const dir = mkdtempSync(join(tmpdir(), 'outreach-'));
  const contactsPath = join(dir, 'contacts.json');
  writeFileSync(contactsPath, JSON.stringify({ contacts: [{ name: 'Test Person', company: job.company, relationship: 'connection', profile_url: 'https://profiles.example.test/test-person' }] }));
  syncContactsFromFile(db, contactsPath, {}, SENT);
  const key = personKey('Test Person', job.company_key, 'https://profiles.example.test/test-person');
  return { db, jobId: job.id, key, contactsPath, dir };
}

test('recording a message saves the person from the contacts list and waits for a reply', () => {
  const { db, jobId, key, dir } = setup();
  const id = recordOutreach(db, { person_key: key, job_id: jobId }, SENT);
  const [rec] = listOutreach(db, SENT);
  assert.equal(rec!.id, id);
  assert.equal(rec!.person_name, 'Test Person');
  assert.equal(rec!.status, 'sent');
  assert.equal(rec!.due, false);
  assert.deepEqual(askedFor(db, jobId), ['Test Person']);
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('the same person and role cannot be recorded twice', () => {
  const { db, jobId, key, dir } = setup();
  recordOutreach(db, { person_key: key, job_id: jobId }, SENT);
  assert.throws(() => recordOutreach(db, { person_key: key, job_id: jobId }, SENT), (err: unknown) => err instanceof ActionError && err.status === 409);
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('a person who is not in the contacts list cannot be recorded', () => {
  const { db, jobId, dir } = setup();
  assert.throws(() => recordOutreach(db, { person_key: 'nobody|x', job_id: jobId }, SENT), (err: unknown) => err instanceof ActionError && err.status === 404);
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('due exactly at seven days; a follow-up restarts the clock and counts', () => {
  const { db, jobId, key, dir } = setup();
  const id = recordOutreach(db, { person_key: key, job_id: jobId }, SENT);
  assert.equal(listOutreach(db, after(6))[0]!.due, false, 'not due at six days');
  assert.equal(listOutreach(db, after(7))[0]!.due, true, 'due at seven days');
  updateOutreach(db, id, 'followed_up', after(7));
  const [rec] = listOutreach(db, after(7));
  assert.equal(rec!.followups, 1);
  assert.equal(rec!.days, 0);
  assert.equal(rec!.due, false, 'the clock restarts after a follow-up');
  assert.equal(rec!.sent_at, SENT, 'the first send date is kept');
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('replied, referred, and dropped are never due; dropped does not count as asked', () => {
  const { db, jobId, key, dir } = setup();
  const id = recordOutreach(db, { person_key: key, job_id: jobId }, SENT);
  updateOutreach(db, id, 'replied', SENT);
  assert.equal(listOutreach(db, after(30))[0]!.due, false);
  updateOutreach(db, id, 'dropped', SENT);
  assert.equal(listOutreach(db, after(30))[0]!.status, 'dropped');
  assert.deepEqual(askedFor(db, jobId), [], 'dropped is not counted in the Inbox tag');
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('a re-sync of the contacts file keeps the outreach record', () => {
  const { db, jobId, key, contactsPath, dir } = setup();
  recordOutreach(db, { person_key: key, job_id: jobId }, SENT);
  syncContactsFromFile(db, contactsPath, {}, after(2));
  assert.equal(listOutreach(db, after(2)).length, 1);
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('the Network row and the Inbox row show the state', () => {
  const { db, jobId, key, dir } = setup();
  recordOutreach(db, { person_key: key, job_id: jobId }, SENT);
  const row = buildNetwork(db, SENT).find((r) => r.outreach.length > 0)!;
  assert.equal(row.outreach[0]!.person_name, 'Test Person');
  assert.equal(row.contacts[0]!.key, key);
  const item = listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).items.find((j) => j.id === jobId)!;
  assert.equal(item.asked, 'Asked Test Person');
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

test('the follow-up keeps the listing link and the sign-off, and sounds like the first message', () => {
  const text = followUpMessage('Ann Friend', 'VML', { title: 'Design Engineer', url: 'https://www.linkedin.com/jobs/view/123/' }, { name: 'Sam Example', ps: 'Call anytime.' });
  assert.match(text, /^Hi Ann, /);
  assert.match(text, /https:\/\/www\.linkedin\.com\/jobs\/view\/123\//);
  assert.match(text, /PS\. Call anytime\./);
  assert.notEqual(text, draftMessage('Ann Friend', 'VML', { title: 'Design Engineer', url: 'https://www.linkedin.com/jobs/view/123/' }, { name: 'Sam Example', ps: 'Call anytime.' }));
});
