import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact, redactString } from '../src/server/log.ts';

test('redacts secret-named keys whatever their value', () => {
  const out = redact({ refresh_token: 'abc', GOG_KEYRING_PASSWORD: 'hunter2', cookie: 'x=1', body: 'hello' }) as Record<string, unknown>;
  assert.equal(out.refresh_token, '[redacted]');
  assert.equal(out.GOG_KEYRING_PASSWORD, '[redacted]');
  assert.equal(out.cookie, '[redacted]');
  assert.equal(out.body, '[redacted]');
});

test('keeps ordinary fields such as refresh timestamps', () => {
  const out = redact({ refresh_id: 'run-7', last_refresh: '2026-10-28T13:12:00Z' }) as Record<string, unknown>;
  assert.equal(out.refresh_id, 'run-7');
  assert.equal(out.last_refresh, '2026-10-28T13:12:00Z');
});

test('redacts OAuth redirect URLs that carry codes', () => {
  const s = redactString('failed to load http://localhost:1/callback?code=4%2F0AbC&state=xyz');
  assert.ok(!s.includes('4%2F0AbC'));
  assert.ok(s.includes('[redacted-url]'));
});

test('redacts email addresses and phone numbers in free text', () => {
  const s = redactString('contact a.person@example.org or 212-555-0147 today');
  assert.ok(!s.includes('a.person@example.org'));
  assert.ok(!s.includes('212-555-0147'));
});

test('redacts bearer tokens and Google access tokens', () => {
  const s = redactString('Authorization: Bearer abcdefghijkl and ya29.a0AfB');
  assert.ok(!s.includes('abcdefghijkl'));
  assert.ok(!s.includes('ya29.a0AfB'));
});

test('logger writes one JSON line per record, redacted, and respects the level', () => {
  const lines: string[] = [];
  const log = createLogger('info', { app: 'test' }, (line) => lines.push(line));
  log.debug('hidden');
  log.info('shown', { refresh_token: 'nope', count: 3 });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0] ?? '{}');
  assert.equal(record.level, 'info');
  assert.equal(record.app, 'test');
  assert.equal(record.refresh_token, '[redacted]');
  assert.equal(record.count, 3);
});
