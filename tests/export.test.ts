import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { seedWeightProfile } from '../src/server/score/profile.ts';
import { scoreNeeded, type ScoringDeps } from '../src/server/score/service.ts';
import { createLogger } from '../src/server/log.ts';
import { setVerdict } from '../src/server/jobs/actions.ts';
import { buildExport, checksum, prepareExport, scanForSecrets, validateExport } from '../src/server/export/export.ts';
import { fixtureMessages } from './support/fixtures.ts';

const NOW = new Date('2026-10-28T20:00:00.000Z');

function populated(): { db: Db; deps: ScoringDeps } {
  const db = openDatabase(':memory:');
  migrate(db);
  seedWeightProfile(db, NOW.toISOString());
  for (const name of ['digest-with-pay', 'single-job-posted-on']) {
    for (const msg of fixtureMessages(name)) {
      for (const p of parseLinkedInAlert(msg).postings) upsertPosting(db, p, NOW.toISOString(), 'linkedin-alert-v1');
    }
  }
  groupNewPostings(db, {}, NOW.toISOString());
  const deps: ScoringDeps = {
    db,
    codex: { model: 'm', reasoningEffort: 'low', status: async () => ({ available: false, detail: 'off' }), extract: async () => ({ ok: false, error: 'unused' }) },
    logger: createLogger('error', {}, () => {}),
    now: () => NOW,
    aliases: {},
    profile: {},
  };
  return { db, deps };
}

// Scores every job in rules-only mode, then records one verdict so the export has a label.
async function prepared(): Promise<Db> {
  const { db, deps } = populated();
  await scoreNeeded(deps, false);
  const first = db.prepare('SELECT id FROM jobs ORDER BY id LIMIT 1').get() as { id: number };
  setVerdict(db, first.id, 'maybe', ['Pay'], 'Check the team', NOW.toISOString());
  return db;
}

test('the export validates against schema version 1 and lists every job', async () => {
  const db = await prepared();
  const doc = buildExport(db, NOW);
  assert.equal(doc.schema_version, 1);
  assert.equal(doc.weights_version, 'v1');
  assert.equal(validateExport(doc).ok, true);
  assert.equal(doc.jobs.length, (db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n);
  db.close();
});

test('jobs are ranked by score, highest first', async () => {
  const db = await prepared();
  const doc = buildExport(db, NOW);
  const scores = doc.jobs.map((j) => j.score as number);
  assert.deepEqual([...scores].sort((a, b) => b - a), scores);
  db.close();
});

test('the file checksum matches the exact text that was written', async () => {
  const db = await prepared();
  const out = prepareExport(db, NOW);
  assert.equal(out.checksum, createHash('sha256').update(out.text).digest('hex'));
  assert.equal(checksum(out.text), out.checksum);
  assert.equal(JSON.parse(out.text).schema_version, 1);
  db.close();
});

test('the export holds no tokens, cookies, credential fields, or raw bodies', async () => {
  const db = await prepared();
  const text = prepareExport(db, NOW).text;
  for (const bad of ['refresh_token', 'access_token', 'client_secret', 'keyring', 'Set-Cookie', 'Bearer ', 'ya29.', 'BEGIN PRIVATE']) {
    assert.equal(text.includes(bad), false, `export contains ${bad}`);
  }
  assert.equal(text.includes('"text"'), false, 'no raw body field');
  assert.equal(text.includes('"raw_fields"'), false, 'no raw fields');
  db.close();
});

test('the secret scan reports rule names, not matched text', () => {
  // A fake token, built at runtime so the repository secret scan does not flag test data.
  const fake = ['ya29', 'a0AfBcdEfGhIjKlMn'].join('.');
  const hits = scanForSecrets(`{"x": "${fake}"}`);
  assert.deepEqual(hits, ['google access token']);
  assert.deepEqual(scanForSecrets('{"x": "plain text"}'), []);
});

test('a document with an extra field fails schema validation', async () => {
  const db = await prepared();
  const doc = { ...buildExport(db, NOW), extra: true };
  assert.equal(validateExport(doc).ok, false);
  db.close();
});

test('a verdict appears as a label and does not change the score in the export', async () => {
  const db = await prepared();
  const before = buildExport(db, NOW).jobs.map((j) => j.score);
  const firstId = (db.prepare('SELECT id FROM jobs ORDER BY id LIMIT 1').get() as { id: number }).id;
  setVerdict(db, firstId, 'bad', ['Other'], null, NOW.toISOString());
  const after = buildExport(db, NOW).jobs;
  assert.deepEqual(after.map((j) => j.score), before);
  assert.equal(after.some((j) => j.verdict === 'bad'), true);
  db.close();
});
