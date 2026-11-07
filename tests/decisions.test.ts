import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionOf } from '../src/shared/decision.ts';
import { SOURCE_CHANNELS, SOURCE_CHANNEL_KEYS, isSourceChannel } from '../src/shared/channels.ts';
import { decisionResults } from '../src/server/jobs/results.ts';
import type { JobListItem } from '../src/shared/types.ts';

type Fields = Pick<JobListItem, 'blocked' | 'rule_blocked' | 'applied' | 'in_analysis' | 'closed' | 'verdict'>;
const fresh: Fields = { blocked: null, rule_blocked: false, applied: null, in_analysis: null, closed: null, verdict: null };

function job(id: number, patch: Partial<JobListItem>): JobListItem {
  return { ...fresh, id, title: 'Designer', url: 'https://example.org/jobs/1', company: 'Acme', location: null, arrangement: null, channels: ['linkedin'], posted_at: null, posted_estimated: false, pay: null, score: null, confidence: null, mode: null, weight_version: null, tn_label: null, direct_tier: 0, direct_label: 'None', flags: [], missing: [], target: null, asked: null, possible_duplicate: false, source_count: 1, first_seen: '', last_seen: '', band: 'unscored', ...patch } as JobListItem;
}

test('each job has one decision, and progressing wins over the other three', () => {
  assert.equal(decisionOf(fresh), 'undecided');
  assert.equal(decisionOf({ ...fresh, verdict: 'bad' }), 'not_interested');
  assert.equal(decisionOf({ ...fresh, verdict: 'maybe' }), 'undecided');
  assert.equal(decisionOf({ ...fresh, closed: { at: 'x', reason: 'y' } }), 'not_available');
  assert.equal(decisionOf({ ...fresh, in_analysis: { reason: 'z' } }), 'progressed');
  assert.equal(decisionOf({ ...fresh, applied: { date: null, reason: 'z', status: 'applied' } }), 'progressed');
  assert.equal(decisionOf({ ...fresh, verdict: 'bad', in_analysis: { reason: 'z' } }), 'progressed');
  assert.equal(decisionOf({ ...fresh, blocked: { at: 'x', reason: 'y' }, verdict: 'bad' }), 'blocked');
});

test('the four channel names come from one list that covers every provider', () => {
  for (const provider of ['linkedin', 'greenhouse', 'ashby', 'jibe', 'workday']) assert.ok(isSourceChannel(provider), provider);
  assert.equal(SOURCE_CHANNELS.linkedin, 'LinkedIn email');
  assert.deepEqual(SOURCE_CHANNEL_KEYS, ['linkedin', 'greenhouse', 'ashby', 'jibe', 'workday']);
  assert.equal(isSourceChannel('indeed'), false);
});

test('results count each job once per decision, by channel and by score band', () => {
  const items = [
    job(1, { channels: ['linkedin'], band: 'good', score: 70 }),
    job(2, { channels: ['linkedin', 'greenhouse'], band: 'review', score: 55, verdict: 'bad' }),
    job(3, { channels: ['greenhouse'], band: 'low', score: 20, in_analysis: { reason: 'r' } }),
    job(4, { channels: ['greenhouse'], band: 'unscored', closed: { at: 'x', reason: 'y' } }),
    job(5, { channels: ['linkedin'], band: 'blocked', blocked: { at: 'x', reason: 'y' } }),
  ];
  const results = decisionResults(items, new Set([1, 2, 5]));
  const linkedin = results.by_channel.find((r) => r.key === 'linkedin')!;
  const greenhouse = results.by_channel.find((r) => r.key === 'greenhouse')!;
  assert.deepEqual(linkedin, { key: 'linkedin', label: 'LinkedIn email', undecided: 1, progressed: 0, not_interested: 1, not_available: 0, opened: 2 });
  assert.deepEqual(greenhouse, { key: 'greenhouse', label: 'Greenhouse', undecided: 0, progressed: 1, not_interested: 1, not_available: 1, opened: 1 });
  const good = results.by_band.find((r) => r.key === 'good')!;
  assert.equal(good.undecided, 1);
  assert.equal(good.opened, 1);
  assert.equal(results.by_band.find((r) => r.key === 'unscored')!.not_available, 1);
  assert.equal(results.by_band.find((r) => r.key === 'low')!.progressed, 1);
});
