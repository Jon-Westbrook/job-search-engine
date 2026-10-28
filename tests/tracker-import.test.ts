import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, type Db } from '../src/server/db/index.ts';
import { buildSnapshot, parseFrontmatter } from '../src/server/tracker/log-snapshot.ts';
import { planFromSnapshot } from '../src/server/tracker/import-plan.ts';
import { applyImport } from '../src/server/tracker/import-apply.ts';
import { findApplicationMatch } from '../src/server/applications.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { fixtureMessages } from './support/fixtures.ts';

// A synthetic log. Names, companies, and titles are invented for the test.
function makeLog(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jse-log-'));
  mkdirSync(join(dir, 'entries'));
  const entry = (name: string, fm: Record<string, string>, body: string) => {
    const lines = ['---', ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), '---', '', body, ''];
    writeFileSync(join(dir, 'entries', name), lines.join('\n'));
  };
  entry('2026-10-01-example-co-application.md', {
    event_date: '2026-10-01',
    date_precision: 'exact',
    logged_date: '2026-10-01',
    type: 'application',
    employer: 'Example Co',
    opportunity: 'Design Engineer',
    person: 'Pat Invented',
    person_role: 'Recruiter',
    channel: 'LinkedIn application',
    status: 'submitted',
  }, 'Narrative that must never be copied into the snapshot.');
  entry('2026-10-05-sample-labs-application.md', {
    event_date: '2026-10-05',
    date_precision: 'approximate',
    logged_date: '2026-10-05',
    type: 'application',
    employer: 'Sample Labs',
    opportunity: 'not provided',
    channel: 'email',
    status: 'in_progress',
  }, 'Body.');
  entry('undated-widget-application.md', {
    event_date: 'null',
    date_precision: 'unknown',
    logged_date: '2026-10-06',
    type: 'application',
    employer: 'Widget Works',
    opportunity: 'Product Designer',
    channel: 'LinkedIn application',
    status: 'interview_scheduled',
  }, 'Body.');
  entry('2026-10-07-interview.md', {
    event_date: '2026-10-07',
    date_precision: 'exact',
    logged_date: '2026-10-07',
    type: 'interview',
    employer: 'Example Co',
    status: 'completed',
  }, 'Not an application.');
  return dir;
}

function treeHash(dir: string): string {
  const h = createHash('sha256');
  for (const f of readdirSync(join(dir, 'entries')).sort()) {
    h.update(f);
    h.update(readFileSync(join(dir, 'entries', f)));
  }
  return h.digest('hex');
}

function freshDb(): Db {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

test('frontmatter parsing finds the event_date line and reads the fields', () => {
  const parsed = parseFrontmatter('---\nevent_date: 2026-10-01\nemployer: Example Co\n---\nbody');
  assert.equal(parsed?.line, 2);
  assert.equal(parsed?.fields.employer, 'Example Co');
  assert.equal(parseFrontmatter('no frontmatter here'), null);
});

test('the snapshot keeps structured fields only: no narrative, no contact names', () => {
  const dir = makeLog();
  const snap = buildSnapshot(dir, '2026-10-28T20:00:00.000Z');
  assert.equal(snap.entry_count, 4);
  const text = JSON.stringify(snap);
  assert.equal(text.includes('Narrative that must never'), false);
  assert.equal(text.includes('Pat Invented'), false);
  assert.equal(text.includes('person'), false);
  const first = snap.entries.find((e) => e.path.endsWith('example-co-application.md'));
  assert.equal(first?.line, 2);
  assert.equal(snap.entries.find((e) => e.event_date === null)?.path, 'entries/undated-widget-application.md');
});

test('the plan maps applications, marks uncertain rows, and never invents a date', () => {
  const plan = planFromSnapshot(buildSnapshot(makeLog(), 'now'));
  assert.equal(plan.applications_in_log, 3);
  assert.equal(plan.counts.skipped_non_application, 1, 'interview entries are not tracker records');
  const exact = plan.rows.find((r) => r.company === 'Example Co');
  assert.equal(exact?.status, 'applied');
  assert.equal(exact?.uncertain, false);
  assert.equal(exact?.applied_at, '2026-10-01');
  const generic = plan.rows.find((r) => r.company === 'Sample Labs');
  assert.equal(generic?.title, 'Not recorded');
  assert.equal(generic?.uncertain, true);
  assert.equal(generic?.applied_at, '2026-10-05', 'an approximate date is kept but flagged');
  const undated = plan.rows.find((r) => r.company === 'Widget Works');
  assert.equal(undated?.applied_at, null, 'an unknown date stays null');
  assert.equal(undated?.status, 'interviewing');
  assert.equal(undated?.uncertain, true);
});

test('import writes the rows once, a re-run adds nothing, and the log is never modified', () => {
  const dir = makeLog();
  const before = treeHash(dir);
  const db = freshDb();
  const plan = planFromSnapshot(buildSnapshot(dir, 'now'));
  const first = applyImport(db, plan, '2026-10-28T20:00:00.000Z');
  assert.equal(first.inserted, 3);
  assert.equal(first.uncertain, 2);
  const second = applyImport(db, plan, '2026-10-28T21:00:00.000Z');
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped_already_imported, 3);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM applications').get() as { n: number }).n, 3);
  const imp = db.prepare("SELECT source_path, source_line, status FROM imports WHERE source_path LIKE 'entries/2026-10-05%'").get() as { source_path: string; source_line: number; status: string };
  assert.equal(imp.status, 'uncertain');
  assert.equal(imp.source_line, 2);
  assert.equal(treeHash(dir), before, 'the log was not modified');
  db.close();
});

test('an imported application matches a listing on company and title, so Progress needs a reason', () => {
  const dir = makeLog();
  const db = freshDb();
  applyImport(db, planFromSnapshot(buildSnapshot(dir, 'now')), '2026-10-28T20:00:00.000Z');
  const msg = fixtureMessages('single-job-no-date')[0]!;
  const [posting] = parseLinkedInAlert({ ...msg, subject: '', text: msg.text }).postings;
  assert.ok(posting);
  upsertPosting(db, { ...posting, company: 'Example Co', title: 'Design Engineer' }, '2026-10-28T20:00:00.000Z', 'linkedin-alert-v1');
  groupNewPostings(db, {}, '2026-10-28T20:00:00.000Z');
  const job = db.prepare("SELECT id, canonical_url, company_key, title_key FROM jobs WHERE title = 'Design Engineer'").get() as { id: number; canonical_url: string; company_key: string; title_key: string };
  const match = findApplicationMatch(db, job);
  assert.equal(match?.reason, 'same company and title');
  assert.equal(match?.applied_at, '2026-10-01');
  db.close();
});
