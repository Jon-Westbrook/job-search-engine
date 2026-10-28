import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openDatabase } from '../src/server/db/index.ts';
import { createGogRunner } from '../src/server/gog/wrapper.ts';
import { seedSources } from '../src/server/ingest/store.ts';
import { runIngestion, type SyncSource } from '../src/server/ingest/sync.ts';
import { createLogger } from '../src/server/log.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK = join(here, 'support', 'gog-mock.mjs');
chmodSync(MOCK, 0o755);

const SOURCE: SyncSource = {
  id: 'linkedin-job-alerts',
  query: 'from:(jobalerts-noreply@linkedin.com)',
  senders: ['jobalerts-noreply@linkedin.com'],
  overlap_days: 3,
  initial_lookback_days: 60,
  parser_version: 'linkedin-alert-v1',
};

function setup(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jse-ingest-'));
  const logPath = join(dir, 'gog-calls.jsonl');
  const db = openDatabase(':memory:');
  migrate(db);
  seedSources(db, [{ ...SOURCE, type: 'gmail', enabled: true }], new Date().toISOString());
  const runner = createGogRunner({
    bin: MOCK,
    account: 'acct@example.org',
    extraEnv: { MOCK_GOG_LOG: logPath, ...extraEnv },
  });
  const logger = createLogger('error', {}, () => {});
  return { db, runner, logPath, logger };
}

function count(db: ReturnType<typeof openDatabase>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

test('a first run stores every listing and a second run creates zero new rows', async () => {
  const { db, runner, logger } = setup();
  const now = () => new Date('2026-10-28T20:00:00Z');

  const first = await runIngestion({ db, runner, logger, now }, SOURCE);
  assert.equal(first.status, 'ok');
  assert.ok(first.counts.inserted > 0, 'first run inserts postings');
  assert.equal(first.counts.inserted, count(db, 'source_postings'));
  assert.equal(first.counts.parseErrors, 0);

  const rowsAfterFirst = count(db, 'source_postings');
  const second = await runIngestion({ db, runner, logger, now }, SOURCE);
  assert.equal(second.counts.inserted, 0, 'no new rows on re-run');
  assert.equal(count(db, 'source_postings'), rowsAfterFirst);
  assert.equal(second.counts.unchanged > 0, true, 'existing rows are recognised');
  db.close();
});

test('the cursor moves to the newest alert and the next window keeps the overlap', async () => {
  const { db, runner, logger, logPath } = setup();
  const result = await runIngestion({ db, runner, logger, now: () => new Date('2026-10-28T20:00:00Z') }, SOURCE);
  assert.ok(result.cursorAfter, 'cursor set');
  assert.ok((result.cursorAfter ?? '') >= '2026-10-22', 'cursor is at the newest fixture');

  await runIngestion({ db, runner, logger, now: () => new Date('2026-10-28T21:00:00Z') }, SOURCE);
  const searches = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] }).filter((c) => c.argv[1] === 'search');
  const last = searches.at(-1)?.argv[2] ?? '';
  const afterSec = Number(/after:(\d+)/.exec(last)?.[1] ?? 0);
  const expected = Date.parse(result.cursorAfter ?? '') / 1000 - 3 * 86400;
  assert.equal(afterSec, Math.floor(expected), 'window starts three days before the cursor');
  db.close();
});

test('a failed thread fetch is recorded, the cursor does not move, and existing rows survive', async () => {
  const good = setup();
  const seeded = await runIngestion({ db: good.db, runner: good.runner, logger: good.logger, now: () => new Date('2026-10-28T20:00:00Z') }, SOURCE);
  const before = count(good.db, 'source_postings');
  const cursorBefore = seeded.cursorAfter;

  // Same database, failing Gog for one thread.
  const failing = createGogRunner({
    bin: MOCK,
    account: 'acct@example.org',
    extraEnv: { MOCK_GOG_LOG: good.logPath, MOCK_GOG_FAIL_THREAD: 'fixture-large-digest-thread' },
  });
  const res = await runIngestion({ db: good.db, runner: failing, logger: good.logger, now: () => new Date('2026-10-28T21:00:00Z') }, SOURCE);
  assert.equal(res.status, 'partial');
  assert.equal(res.counts.fetchErrors, 1);
  assert.equal(res.errors.some((e) => e.thread_id === 'fixture-large-digest-thread'), true);
  assert.equal(res.cursorAfter, cursorBefore, 'cursor held back');
  assert.equal(count(good.db, 'source_postings'), before, 'nothing erased');
  good.db.close();
});

test('the ingest path never calls a write command', async () => {
  const { db, runner, logger, logPath } = setup();
  await runIngestion({ db, runner, logger, now: () => new Date('2026-10-28T20:00:00Z') }, SOURCE);
  const calls = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; refused: boolean });
  assert.ok(calls.length > 0);
  assert.equal(calls.some((c) => c.refused), false, 'every call is a read');
  assert.equal(calls.every((c) => c.argv[0] === 'gmail' || c.argv[0] === 'auth'), true);
  db.close();
});

test('the Gmail labels and the alert message count are unchanged by a run', async () => {
  const { db, runner, logger } = setup();
  const labelsBefore = await runner.run({ kind: 'labelsList' });
  await runIngestion({ db, runner, logger, now: () => new Date('2026-10-28T20:00:00Z') }, SOURCE);
  const labelsAfter = await runner.run({ kind: 'labelsList' });
  assert.deepEqual(labelsAfter.data, labelsBefore.data);
  db.close();
});

test('the seeded source row exists and the mock fixture directory is present', () => {
  const { db } = setup();
  const row = db.prepare('SELECT id, query FROM source_configs').get() as { id: string; query: string };
  assert.equal(row.id, 'linkedin-job-alerts');
  assert.match(row.query, /jobalerts-noreply/);
  assert.ok(existsSync(join(here, '..', 'fixtures', 'linkedin')));
  db.close();
});
