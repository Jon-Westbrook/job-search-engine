import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, createGogRunner, isReadOnly, type ExecFn, type GogOp } from '../src/server/gog/wrapper.ts';

const WRITE_WORDS = ['send', 'modify', 'trash', 'archive', 'untrash', 'spam', 'batch', 'delete', 'create'];

test('every read operation carries --no-input and the account, and never a write verb', () => {
  const ops: GogOp[] = [
    { kind: 'search', query: 'from:(x@y.z)', max: 100 },
    { kind: 'threadGet', threadId: 't1' },
    { kind: 'labelsList' },
  ];
  for (const op of ops) {
    const args = buildArgs(op, 'acct@example.org');
    assert.ok(args.includes('--no-input'), op.kind);
    assert.ok(args.includes('--account'), op.kind);
    assert.equal(args.includes('--readonly'), false, 'readonly is not a valid flag on these commands');
    for (const word of WRITE_WORDS) {
      assert.equal(args.includes(word), false, `${op.kind} has write verb ${word}`);
    }
    assert.equal(isReadOnly(op), true);
  }
});

test('search passes the query as one argument, not through a shell', () => {
  const args = buildArgs({ kind: 'search', query: 'from:(a@b.c) after:1', max: 100, page: '2' }, 'acct');
  assert.equal(args[2], 'from:(a@b.c) after:1');
  assert.ok(args.includes('--page'));
  assert.equal(args[args.indexOf('--page') + 1], '2');
});

test('thread get asks for full bodies and the thread ID as an argument', () => {
  assert.deepEqual(buildArgs({ kind: 'threadGet', threadId: 'abc' }, 'acct').slice(0, 5), ['gmail', 'thread', 'get', 'abc', '--full']);
});

test('auth operations are not read-only, and step 2 is the only one that carries a URL', () => {
  assert.equal(isReadOnly({ kind: 'authAddStep1', account: 'a@b.c' }), false);
  assert.equal(isReadOnly({ kind: 'authAddStep2', account: 'a@b.c', redirectUrl: 'http://127.0.0.1/?code=1' }), false);
  const step1 = buildArgs({ kind: 'authAddStep1', account: 'a@b.c' }, '');
  assert.ok(step1.includes('--remote') && step1.includes('--step') && step1.includes('1'));
  assert.equal(step1.includes('--auth-url'), false);
});

test('no account means no Gmail call', () => {
  assert.throws(() => buildArgs({ kind: 'labelsList' }, ''), /account is required/);
});

test('the runner passes the keyring password through the environment only, never in argv', async () => {
  const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exec: ExecFn = async (_file, args, opts) => {
    seen.push({ args, env: opts.env });
    return { stdout: '{"threads":[]}', stderr: '', code: 0 };
  };
  const runner = createGogRunner({ bin: '/fake/gog', account: 'acct', keyringPassword: 'pw-secret-123', exec });
  const res = await runner.run({ kind: 'search', query: 'q', max: 10 });
  assert.equal(res.ok, true);
  assert.equal(seen[0]?.env.GOG_KEYRING_PASSWORD, 'pw-secret-123');
  assert.equal(seen[0]?.args.some((a) => a.includes('pw-secret-123')), false);
});

test('a failed auth step 2 never echoes the redirect URL in the error', async () => {
  const redirect = 'http://127.0.0.1:9/callback?code=4%2F0AbCdEf&state=s';
  const exec: ExecFn = async () => ({ stdout: '', stderr: `bad request for ${redirect}`, code: 1 });
  const runner = createGogRunner({ bin: '/fake/gog', account: 'acct', exec });
  const res = await runner.run({ kind: 'authAddStep2', account: 'acct', redirectUrl: redirect });
  assert.equal(res.ok, false);
  assert.equal(res.error?.includes('4%2F0AbCdEf'), false);
  assert.equal(res.error?.includes('redacted'), true);
});

test('non-JSON output from a read is a failure, not a parsed value', async () => {
  const exec: ExecFn = async () => ({ stdout: 'hello', stderr: '', code: 0 });
  const runner = createGogRunner({ bin: '/fake/gog', account: 'acct', exec });
  const res = await runner.run({ kind: 'labelsList' });
  assert.equal(res.ok, false);
});
