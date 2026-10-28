import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GogOp, GogResult, GogRunner } from '../src/server/gog/wrapper.ts';
import { finishGmailAuth, looksLikeRedirect, startGmailAuth, gmailHealth } from '../src/server/gog/setup.ts';

function fakeRunner(handler: (op: GogOp) => GogResult<unknown>): GogRunner & { calls: GogOp[] } {
  const calls: GogOp[] = [];
  return {
    calls,
    async run<T = unknown>(op: GogOp): Promise<GogResult<T>> {
      calls.push(op);
      return handler(op) as GogResult<T>;
    },
  };
}

test('looksLikeRedirect accepts a localhost address with a code or state, and rejects other text', () => {
  assert.equal(looksLikeRedirect('http://localhost:1/callback?code=abc&state=x'), true);
  assert.equal(looksLikeRedirect('https://example.org/?state=x'), true);
  assert.equal(looksLikeRedirect('not a url'), false);
  assert.equal(looksLikeRedirect('ftp://example.org/?code=1'), false);
  assert.equal(looksLikeRedirect('http://example.org/home'), false);
});

test('finish refuses a pasted value that is not a redirect, without calling Gog', async () => {
  const runner = fakeRunner(() => ({ ok: true }));
  const res = await finishGmailAuth(runner, 'acct', 'hello there');
  assert.equal(res.status, 'failed');
  assert.equal(runner.calls.length, 0);
});

test('finish runs the step 2 exchange and then the real read check', async () => {
  const runner = fakeRunner((op) => (op.kind === 'authAddStep2' ? { ok: true, data: 'ok' } : { ok: true, data: {} }));
  const res = await finishGmailAuth(runner, 'acct', 'http://127.0.0.1:9/?code=abc');
  assert.deepEqual(res, { status: 'connected' });
  assert.deepEqual(runner.calls.map((c) => c.kind), ['authAddStep2', 'labelsList']);
});

test('start asks for confirmation before replacing a working Gmail token', async () => {
  const runner = fakeRunner(() => ({ ok: true, data: {} }));
  const res = await startGmailAuth(runner, 'acct', false);
  assert.equal(res.status, 'confirm_required');
  assert.equal(runner.calls.some((c) => c.kind === 'authAddStep1'), false);
});

test('start returns the sign-in link when Gmail is not connected yet', async () => {
  const runner = fakeRunner((op) => {
    if (op.kind === 'labelsList') return { ok: false, error: 'token expired' };
    return { ok: true, data: 'Open this link:\nhttps://accounts.example.org/o/oauth2/auth?client_id=x\n' };
  });
  const res = await startGmailAuth(runner, 'acct', false);
  assert.equal(res.status, 'link_ready');
  if (res.status === 'link_ready') assert.match(res.url, /^https:\/\/accounts\.example\.org/);
});

test('health reports the Gog error text when the read fails', async () => {
  const runner = fakeRunner(() => ({ ok: false, error: 'gog labels list failed (exit 1): token expired' }));
  const res = await gmailHealth(runner);
  assert.deepEqual(res, { connected: false, reason: 'gog labels list failed (exit 1): token expired' });
});
