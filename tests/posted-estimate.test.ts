import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WEIGHTS } from '../src/server/score/profile.ts';
import { scoreListing, type Extraction, type ScoreInput } from '../src/server/score/rules.ts';
import { openDatabase, migrate, type Db } from '../src/server/db/index.ts';
import { parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';
import { upsertPosting } from '../src/server/ingest/store.ts';
import { groupNewPostings } from '../src/server/grouping.ts';
import { earliestAlertAt } from '../src/server/jobs/posted.ts';
import { listJobs } from '../src/server/jobs/read.ts';
import { fixtureMessages } from './support/fixtures.ts';

const NOW = new Date('2026-10-28T20:00:00.000Z');

// An AI extraction, so the score is in ai mode and confidence is not fixed at Low by rules-only mode.
const EXTRACTION: Extraction = {
  tn: { class: 'design_centric', evidence: [{ quote: 'Design Engineer', field: 'title' }] },
  role: {
    seniority_match: { value: 0.8, evidence: [{ quote: 'Design Engineer', field: 'title' }] },
    design_engineering_balance: { value: 0.9, evidence: [{ quote: 'Design Engineer', field: 'title' }] },
    stack_overlap: { value: 0.7, evidence: [{ quote: 'Design Engineer', field: 'title' }] },
  },
  role_family: 'design engineering',
  missing: [],
};

function base(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    now: NOW,
    weights: { ...DEFAULT_WEIGHTS },
    title: 'Design Engineer',
    company: 'Lumen Health',
    location: 'New York, NY',
    arrangement: 'hybrid',
    postedAt: null,
    pay: null,
    easyApply: false,
    directTier: 0,
    description: null,
    resumeText: '',
    extraSources: [],
    extraction: null,
    acceptedGeography: ['new york'],
    tnHostileAgencies: [],
    companyKey: 'lumen health',
    alreadyApplied: false,
    possibleDuplicate: false,
    ...overrides,
  };
}

test('an estimated posting time scores recency and is flagged, not forced to Low', () => {
  const alert = new Date(NOW.getTime() - 2 * 86_400_000).toISOString();
  const out = scoreListing(base({ postedAt: alert, postedEstimated: true, extraction: EXTRACTION, description: 'A full description.' }));
  assert.equal(out.mode, 'ai');
  const recency = out.factors.find((f) => f.factor === 'Recency');
  assert.ok(recency, 'recency factor present');
  assert.notEqual(recency.points, 5, 'not the unknown-time default');
  assert.equal(recency.confidence, 'medium');
  assert.match(recency.aiValue ?? '', /estimated from alert date/);
  assert.ok(out.flags.includes('Posting time estimated from the alert date'));
  assert.ok(!out.missing.includes('posting time'));
  assert.equal(out.confidence, 'high', 'an estimate does not force Low; the same listing with a stated time is high too');
  const stated = scoreListing(base({ postedAt: alert, postedEstimated: false, extraction: EXTRACTION, description: 'A full description.' }));
  assert.equal(out.confidence, stated.confidence);
});

test('no stated time and no estimate still gives Low confidence', () => {
  const out = scoreListing(base({ postedAt: null, postedEstimated: false, extraSources: ['recruiter email'] }));
  assert.equal(out.confidence, 'low');
  assert.ok(out.missing.includes('posting time'));
});

test('a stated posting time is not marked as an estimate', () => {
  const out = scoreListing(base({ postedAt: new Date(NOW.getTime() - 3_600_000).toISOString(), postedEstimated: false }));
  assert.ok(!out.flags.includes('Posting time estimated from the alert date'));
});

function ingest(db: Db, fixture: string, receivedAt: string): number {
  const [posting] = parseLinkedInAlert(fixtureMessages(fixture)[0]!).postings;
  assert.ok(posting);
  const { postingId } = upsertPosting(db, posting, receivedAt, 'linkedin-alert-v1');
  groupNewPostings(db, {}, receivedAt);
  return postingId;
}

test('the estimate is the earliest alert, not the latest', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const postingId = ingest(db, 'single-job-no-date', '2026-10-01T12:00:00.000Z');
  const job = db.prepare('SELECT job_id FROM job_sources WHERE posting_id = ?').get(postingId) as { job_id: number };
  const first = earliestAlertAt(db, job.job_id);
  assert.ok(first, 'the fixture alert gives a date');
  const observe = (at: string, id: string) =>
    db
      .prepare(
        `INSERT INTO posting_observations (posting_id, message_id, thread_id, alert_received_at, parser_version, observed_at)
         VALUES (?, ?, ?, ?, 'linkedin-alert-v1', ?)`,
      )
      .run(postingId, id, `${id}-thread`, at, at);
  // A later alert does not make the job newer.
  observe('2026-12-01T12:00:00.000Z', 'later-msg');
  assert.equal(earliestAlertAt(db, job.job_id), first);
  // An earlier alert does move the estimate back.
  observe('2026-08-15T12:00:00.000Z', 'earlier-msg');
  assert.equal(earliestAlertAt(db, job.job_id), '2026-08-15T12:00:00.000Z');
  db.close();
});

test('the Inbox shows an estimated time with the est. flag, and a stated time without it', () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const postingId = ingest(db, 'single-job-no-date', '2026-10-01T12:00:00.000Z');
  const job = db.prepare('SELECT job_id FROM job_sources WHERE posting_id = ?').get(postingId) as { job_id: number };
  const item = listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).items[0]!;
  assert.equal(item.posted_at, earliestAlertAt(db, job.job_id));
  assert.equal(item.posted_estimated, true);
  db.close();
});
