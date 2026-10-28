import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { migrate, openDatabase, loadMigrations } from '../src/server/db/index.ts';
import { createLogger } from '../src/server/log.ts';
import { RefreshService } from '../src/server/refresh.ts';
import { createGogRunner } from '../src/server/gog/wrapper.ts';
import { createCodexRunner } from '../src/server/score/codex.ts';

function startApp(basePath: string, webDist: string): Promise<{ server: Server; base: string }> {
  const config = { ...loadConfig({ BASE_PATH: basePath }, '/repo'), webDist };
  const db = openDatabase(':memory:');
  migrate(db);
  const logger = createLogger('error', {}, () => {});
  const runner = createGogRunner({ bin: '/nonexistent/gog', account: '' });
  const handler = createApp({
    config,
    db,
    logger,
    schemaVersion: loadMigrations().length,
    runner,
    refresh: new RefreshService({ db, runner, logger, aliases: {} }, []),
    sources: [],
    gmailAccount: '',
    codex: createCodexRunner({ bin: '/nonexistent/codex', model: 'm', reasoningEffort: 'low', timeoutMs: 1000 }),
    codexBin: '/nonexistent/codex',
    aliases: {},
    rescore: async () => {},
  });
  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jse-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

test('health answers under the base path with status ok', async () => {
  const { server, base } = await startApp('/job-search', makeDist());
  try {
    const res = await fetch(`${base}/job-search/api/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; app: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.app, 'AUTOJOB');
    assert.equal((await fetch(`${base}/api/v1/health`)).status, 404);
  } finally {
    server.close();
  }
});

test('index.html gets a base tag and the security headers', async () => {
  const { server, base } = await startApp('/job-search', makeDist());
  try {
    const res = await fetch(`${base}/job-search/`);
    const html = await res.text();
    assert.match(html, /<base href="\/job-search\/">/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  } finally {
    server.close();
  }
});

test('the bare base path redirects to the trailing slash', async () => {
  const { server, base } = await startApp('/job-search', makeDist());
  try {
    const res = await fetch(`${base}/job-search`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/job-search/');
  } finally {
    server.close();
  }
});

test('unknown paths return a JSON 404', async () => {
  const { server, base } = await startApp('', makeDist());
  try {
    const res = await fetch(`${base}/no/such/thing`);
    assert.equal(res.status, 404);
    assert.equal(((await res.json()) as { error: string }).error, 'not_found');
  } finally {
    server.close();
  }
});
