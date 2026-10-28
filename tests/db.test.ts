import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase, loadMigrations } from '../src/server/db/index.ts';

function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

test('migrations apply in order and a second run is a no-op', () => {
  const db = openDatabase(':memory:');
  const first = migrate(db);
  assert.equal(first.length, loadMigrations().length);
  assert.deepEqual(migrate(db), []);
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
  assert.deepEqual(versions.map((v) => v.version), loadMigrations().map((m) => m.version));
  db.close();
});

test('every migration file has a unique, contiguous version', () => {
  const versions = loadMigrations().map((m) => m.version);
  assert.deepEqual(versions, versions.map((_, i) => i + 1));
});

test('job_events is append-only', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO jobs (canonical_url, title, first_seen, last_seen, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('https://www.linkedin.com/jobs/view/1/', 'Designer', 'now', 'now', 'now');
  db.prepare(`INSERT INTO job_events (job_id, type, created_at) VALUES (1, 'created', 'now')`).run();
  assert.throws(() => db.exec(`UPDATE job_events SET type = 'merged'`), /append-only/);
  assert.throws(() => db.exec(`DELETE FROM job_events`), /append-only/);
  db.close();
});

test('verdict feedback is append-only and the verdict check rejects unknown values', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO jobs (canonical_url, title, first_seen, last_seen, created_at) VALUES (?, ?, ?, ?, ?)`).run('u', 't', 'n', 'n', 'n');
  assert.throws(() => db.prepare(`INSERT INTO feedback (job_id, verdict, created_at) VALUES (1, 'great', 'now')`).run(), /CHECK/);
  db.prepare(`INSERT INTO feedback (job_id, verdict, created_at) VALUES (1, 'good', 'now')`).run();
  assert.throws(() => db.exec(`UPDATE feedback SET verdict = 'bad'`), /append-only/);
  db.close();
});
