import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { directTierFor } from '../src/server/contacts.ts';
import { listJobs } from '../src/server/jobs/read.ts';
import { ListError, loadTargetFile, syncContactsFromFile, syncTargets } from '../src/server/lists.ts';
import { fixtureMessages } from './support/fixtures.ts';

const NOW = '2026-10-28T20:00:00.000Z';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'lists-'));
}

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

test('a target file reads strings and grouped entries, and rejects a bad shape', () => {
  const dir = tempDir();
  try {
    const good = join(dir, 'targets.json');
    writeFileSync(good, JSON.stringify({ targets: ['VML', { name: 'McCann', group: 'Omnicom' }] }));
    assert.deepEqual(loadTargetFile(good), [{ name: 'VML' }, { name: 'McCann', group: 'Omnicom' }]);
    assert.deepEqual(loadTargetFile(join(dir, 'missing.json')), []);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ targets: [{ group: 'no name' }] }));
    assert.throws(() => loadTargetFile(bad), ListError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a job at a listed company is tagged, filtered, and sorted first', () => {
  const { db, companies } = withJobs();
  const pick = companies[companies.length - 1]!;
  syncTargets(db, [{ name: pick }], {}, NOW);
  const all = listJobs(db, { filter: 'all', direct: 'any', sort: 'score' });
  const tagged = all.items.filter((j) => j.target);
  assert.ok(tagged.length >= 1);
  assert.equal(tagged[0]!.target, pick);
  assert.equal(all.counts.targets, tagged.length);
  const filtered = listJobs(db, { filter: 'targets', direct: 'any', sort: 'score' }).items;
  assert.ok(filtered.every((j) => j.target));
  const first = listJobs(db, { filter: 'all', direct: 'any', sort: 'targets' }).items[0]!;
  assert.ok(first.target, 'a target job sorts first');
  db.close();
});

test('a group is a target too, and its members keep their own name on the tag', () => {
  const { db } = withJobs();
  syncTargets(db, [{ name: 'Any Agency', group: 'Group Name' }], {}, NOW);
  const rows = db.prepare('SELECT company_key, name, group_name FROM targets ORDER BY company_key').all() as Array<{ company_key: string; name: string; group_name: string | null }>;
  assert.deepEqual(rows.map((r) => r.name).sort(), ['Any Agency', 'Group Name']);
  assert.equal(rows.find((r) => r.name === 'Any Agency')?.group_name, 'Group Name');
  db.close();
});

test('a contact from the file raises the Direct tier, and a re-sync replaces only file contacts', () => {
  const { db, companies } = withJobs();
  const company = companies[0]!;
  const dir = tempDir();
  try {
    const path = join(dir, 'contacts.json');
    writeFileSync(path, JSON.stringify({ contacts: [{ name: 'Test Friend', company, relationship: 'friend' }] }));
    assert.equal(syncContactsFromFile(db, path, {}, NOW), 1);
    const key = (db.prepare('SELECT company_key FROM contacts LIMIT 1').get() as { company_key: string }).company_key;
    assert.equal(directTierFor(db, key, {}), 1);

    // A contact entered another way is not removed by a file sync.
    db.prepare("INSERT INTO contacts (name, company, company_key, relationship, provenance, created_at) VALUES ('Hand Entered', ?, ?, 'referral', NULL, ?)").run(company, key, NOW);
    writeFileSync(path, JSON.stringify({ contacts: [] }));
    syncContactsFromFile(db, path, {}, NOW);
    const left = db.prepare('SELECT name FROM contacts').all() as Array<{ name: string }>;
    assert.deepEqual(left.map((r) => r.name), ['Hand Entered']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('a contact with an unknown relationship is refused', () => {
  const { db } = withJobs();
  const dir = tempDir();
  try {
    const path = join(dir, 'contacts.json');
    writeFileSync(path, JSON.stringify({ contacts: [{ name: 'X', company: 'Y', relationship: 'stranger' }] }));
    assert.throws(() => syncContactsFromFile(db, path, {}, NOW), ListError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});
