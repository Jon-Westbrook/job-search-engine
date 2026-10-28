import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertNotLinkedIn, guardedFetch, isLinkedInHost, LinkedInRequestBlocked } from '../src/server/net/guard.ts';

test('linkedin.com and every subdomain are blocked', () => {
  for (const host of ['linkedin.com', 'www.linkedin.com', 'LinkedIn.com', 'static.licdn.linkedin.com', 'linkedin.com.']) {
    assert.equal(isLinkedInHost(host), true, host);
  }
});

test('other hosts are allowed and lookalike domains are not blocked', () => {
  for (const host of ['example.org', 'notlinkedin.com', 'linkedin.com.evil.test', 'licdn.com']) {
    assert.equal(isLinkedInHost(host), false, host);
  }
});

test('assertNotLinkedIn throws for a LinkedIn URL', () => {
  assert.throws(() => assertNotLinkedIn('https://www.linkedin.com/jobs/view/4483690435/'), LinkedInRequestBlocked);
});

test('guardedFetch refuses LinkedIn before any network call', async () => {
  await assert.rejects(() => guardedFetch('https://www.linkedin.com/jobs/view/1/'), LinkedInRequestBlocked);
});
