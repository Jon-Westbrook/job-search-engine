import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, normalizeBasePath } from '../src/server/config.ts';

test('defaults bind to loopback on port 3460', () => {
  const c = loadConfig({}, '/repo');
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.port, 3460);
  assert.equal(c.basePath, '');
  assert.equal(c.codex.model, 'gpt-5.6-luna');
  assert.equal(c.codex.rulesOnly, false);
});

test('refuses any non-loopback bind address', () => {
  assert.throws(() => loadConfig({ HOST: '0.0.0.0' }), /loopback/);
  assert.throws(() => loadConfig({ HOST: '10.0.0.5' }), /loopback/);
  assert.doesNotThrow(() => loadConfig({ HOST: '::1' }));
});

test('rejects an invalid port', () => {
  assert.throws(() => loadConfig({ PORT: 'eighty' }), /PORT/);
});

test('normalizes base paths', () => {
  assert.equal(normalizeBasePath('/job-search/'), '/job-search');
  assert.equal(normalizeBasePath('job-search'), '/job-search');
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
});

test('reads the Gog account and Codex settings from the environment', () => {
  const c = loadConfig({ GOG_ACCOUNT: 'acct@example.org', CODEX_MODEL: 'gpt-x', SCORE_RULES_ONLY: '1' }, '/repo');
  assert.equal(c.gog.account, 'acct@example.org');
  assert.equal(c.codex.model, 'gpt-x');
  assert.equal(c.codex.rulesOnly, true);
});
