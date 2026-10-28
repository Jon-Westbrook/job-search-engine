import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureMessages } from './support/fixtures.ts';
import { arrangementOf, findPay, findPosted, parseLinkedInAlert } from '../src/server/ingest/linkedin.ts';

function parse(name: string) {
  const [msg] = fixtureMessages(name);
  assert.ok(msg, `fixture ${name} has a message`);
  return parseLinkedInAlert(msg);
}

test('digest with pay parses every listing and the pay line is not read as a location', () => {
  const { postings, errors } = parse('digest-with-pay');
  assert.deepEqual(errors, []);
  assert.equal(postings.length, 8);
  const lunon = postings.find((p) => p.title === 'Forward Deployed AI Engineer');
  assert.ok(lunon, 'Lunon listing present');
  assert.equal(lunon.company, 'Lunon');
  assert.equal(lunon.location, 'New York, NY');
  assert.deepEqual({ min: lunon.pay?.min, max: lunon.pay?.max, period: lunon.pay?.period }, { min: 160000, max: 210000, period: 'year' });
});

test('singular "1 company alum" is a flag, so title, company, and location stay aligned', () => {
  const { postings } = parse('digest-alumni-connection');
  const rho = postings.find((p) => p.sourceId === '4456968548');
  assert.ok(rho);
  assert.equal(rho.title, 'Staff / Principal Product Designer, Design Systems');
  assert.equal(rho.company, 'Rho');
  assert.equal(rho.location, 'New York, NY');
  assert.equal(rho.connectionHint.companyAlumni, 1);
});

test('Easy Apply is set only when the alert says so, and unknown stays null', () => {
  const { postings } = parse('digest-alumni-connection');
  const easy = postings.find((p) => p.sourceId === '4471500321');
  const plain = postings.find((p) => p.sourceId === '4438251840');
  assert.equal(easy?.easyApply, true);
  assert.equal(plain?.easyApply, false);
});

test('the subject date applies to a single-job alert', () => {
  const { postings, errors } = parse('single-job-posted-on');
  assert.deepEqual(errors, []);
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.postedAt, '2026-10-23');
  assert.equal(postings[0]?.postedPrecision, 'date');
});

test('a single-job alert with no date keeps posting time null', () => {
  const { postings } = parse('single-job-no-date');
  assert.equal(postings.length, 1);
  assert.equal(postings[0]?.postedAt, null);
  assert.equal(postings[0]?.company, 'Sesame');
});

test('digests never borrow the subject date for every listing', () => {
  const [msg] = fixtureMessages('large-digest');
  assert.ok(msg);
  const subjected = { ...msg, subject: 'Some Title posted on 10/26/26' };
  const { postings } = parseLinkedInAlert(subjected);
  assert.ok(postings.length > 1);
  assert.ok(postings.every((p) => p.postedAt === null), 'no listing gets the subject date');
});

test('a message that is wrapped in a thread parses like a plain message', () => {
  const { postings, errors } = parse('thread-wrapped');
  assert.deepEqual(errors, []);
  assert.equal(postings.length, 6);
  const zovu = postings.find((p) => p.sourceId === '4467141352');
  assert.equal(zovu?.arrangement, 'remote');
});

test('every posting has the canonical URL, a title, and the message provenance', () => {
  for (const name of ['digest-with-pay', 'digest-alumni-connection', 'large-digest', 'single-job-posted-on', 'single-job-no-date', 'thread-wrapped']) {
    const { postings } = parse(name);
    for (const p of postings) {
      assert.match(p.url, /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/, `${name}: canonical URL`);
      assert.ok(p.title.length > 0, `${name}: title present`);
      assert.ok(p.messageId.startsWith('fixture-'), `${name}: provenance kept`);
      assert.ok(p.alertReceivedAt.startsWith('2026-'), `${name}: receive time kept`);
    }
  }
});

test('a message with no readable text returns an error and no postings', () => {
  const result = parseLinkedInAlert({ id: 'm1', threadId: 't1', receivedAt: '2026-10-28T00:00:00Z', from: 'x', subject: '', text: '   ' });
  assert.equal(result.postings.length, 0);
  assert.match(result.errors[0] ?? '', /no readable text part/);
});

test('an email with no job links is reported, not silently accepted', () => {
  const result = parseLinkedInAlert({ id: 'm2', threadId: 't2', receivedAt: '2026-10-28T00:00:00Z', from: 'x', subject: '', text: 'Hello\nNo jobs here' });
  assert.equal(result.postings.length, 0);
  assert.match(result.errors[0] ?? '', /no job listings/);
});

test('a job link without a numeric ID is an error for that message only', () => {
  const text = 'Engineer\nAcme\nNew York, NY\nView job: https://www.linkedin.com/jobs/view/abc/\n';
  const result = parseLinkedInAlert({ id: 'm3', threadId: 't3', receivedAt: '2026-10-28T00:00:00Z', from: 'x', subject: '', text });
  assert.equal(result.postings.length, 0);
  assert.match(result.errors[0] ?? '', /without a job ID/);
});

test('findPay reads annual, hourly, and ranged amounts, and leaves unknown periods null', () => {
  assert.deepEqual(findPay('starting at $200K/year'), { min: 200000, max: 200000, currency: 'USD', period: 'year', annualized: true, raw: '$200K/year' });
  const range = findPay('$185K-$210K / year');
  assert.equal(range?.min, 185000);
  assert.equal(range?.max, 210000);
  assert.equal(findPay('$150,000 - $175,000 per year')?.max, 175000);
  const hourly = findPay('$60/hr');
  assert.equal(hourly?.period, 'hour');
  assert.equal(hourly?.annualized, false);
  assert.equal(findPay('$150,000')?.period, null);
  assert.equal(findPay('no money mentioned'), null);
});

test('arrangement comes only from words in the listing', () => {
  assert.equal(arrangementOf(['Designer', 'New York (Hybrid)']), 'hybrid');
  assert.equal(arrangementOf(['Designer', 'Remote, US']), 'remote');
  assert.equal(arrangementOf(['Designer', 'On-site']), 'onsite');
  assert.equal(arrangementOf(['Designer', 'New York, NY']), null);
});

test('findPosted returns null for a listing without a stated time', () => {
  const msg = { id: 'x', threadId: 'x', receivedAt: '2026-10-28T12:00:00Z', from: '', subject: 'Plain subject', text: '' };
  assert.equal(findPosted(msg, ['Designer', 'Acme', 'New York, NY'], true), null);
});

test('findPosted reads a relative time from the block and anchors it to the receive time', () => {
  const msg = { id: 'x', threadId: 'x', receivedAt: '2026-10-28T12:00:00.000Z', from: '', subject: '', text: '' };
  const found = findPosted(msg, ['2 hours ago'], true);
  assert.equal(found?.precision, 'relative');
  assert.equal(found?.value, '2026-10-28T10:00:00.000Z');
});
