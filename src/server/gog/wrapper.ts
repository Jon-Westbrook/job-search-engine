import { execFile } from 'node:child_process';
import { redactString } from '../log.ts';

// The only Gog operations this app can run. Each one maps to a fixed argv shape.
// Anything not listed here is refused. Gmail writes (send, modify, label, trash, archive,
// mark read) have no entry, so the wrapper cannot run them.
//
// Gog 0.11.x on the host does not accept --readonly or --gmail-no-send on gmail search,
// get, thread get, or labels list. Read-only is enforced by this allowlist plus --no-input.
export type GogOp =
  | { kind: 'search'; query: string; max: number; page?: string }
  | { kind: 'threadGet'; threadId: string }
  | { kind: 'labelsList' }
  | { kind: 'authStatus' }
  | { kind: 'authAddStep1'; account: string }
  | { kind: 'authAddStep2'; account: string; redirectUrl: string };

export type GogOpKind = GogOp['kind'];

export const READ_ONLY_KINDS: ReadonlySet<GogOpKind> = new Set<GogOpKind>([
  'search',
  'threadGet',
  'labelsList',
  'authStatus',
]);

export function buildArgs(op: GogOp, account: string): string[] {
  switch (op.kind) {
    case 'search': {
      const args = ['gmail', 'search', op.query, '--max', String(op.max), '--json', '--no-input'];
      if (op.page) args.push('--page', op.page);
      return withAccount(args, account);
    }
    case 'threadGet':
      return withAccount(['gmail', 'thread', 'get', op.threadId, '--full', '--json', '--no-input'], account);
    case 'labelsList':
      return withAccount(['gmail', 'labels', 'list', '--json', '--no-input'], account);
    case 'authStatus':
      return ['auth', 'status', '--json', '--no-input'];
    case 'authAddStep1':
      return ['auth', 'add', op.account, '--services', 'gmail', '--remote', '--step', '1', '--no-input'];
    case 'authAddStep2':
      return ['auth', 'add', op.account, '--services', 'gmail', '--remote', '--step', '2', '--auth-url', op.redirectUrl, '--no-input'];
  }
}

function withAccount(args: string[], account: string): string[] {
  if (!account) throw new Error('A Gmail account is required. Set GOG_ACCOUNT or config/profile.json.');
  return [...args, '--account', account];
}

export interface GogResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface GogRunner {
  run<T = unknown>(op: GogOp): Promise<GogResult<T>>;
}

export interface GogOptions {
  bin: string;
  account: string;
  timeoutMs?: number;
  keyringPassword?: string;
  // Test seams. Defaults: execFile, and no extra environment.
  exec?: ExecFn;
  extraEnv?: Record<string, string>;
}

export type ExecFn = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const defaultExec: ExecFn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? ((err as unknown as { code: number }).code) : err ? 1 : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });

export function createGogRunner(opts: GogOptions): GogRunner {
  const exec = opts.exec ?? defaultExec;
  const timeout = opts.timeoutMs ?? 60_000;
  return {
    async run<T = unknown>(op: GogOp): Promise<GogResult<T>> {
      const accountFree = op.kind === 'authStatus';
      const args = accountFree ? buildArgs(op, '') : buildArgs(op, opts.account);
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        LANG: 'en_US.UTF-8',
      };
      if (opts.keyringPassword) env.GOG_KEYRING_PASSWORD = opts.keyringPassword;
      Object.assign(env, opts.extraEnv ?? {});
      const result = await exec(opts.bin, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 });
      // Never echo argv for the auth step 2 call: it carries the redirect URL.
      const label = op.kind === 'authAddStep2' ? 'auth add step 2' : op.kind;
      if (result.code !== 0) {
        return { ok: false, error: `gog ${label} failed (exit ${result.code}): ${redactString(result.stderr.trim()).slice(0, 400)}` };
      }
      if (op.kind === 'authAddStep1' || op.kind === 'authAddStep2') {
        return { ok: true, data: result.stdout.trim() as T };
      }
      try {
        return { ok: true, data: JSON.parse(result.stdout) as T };
      } catch {
        return { ok: false, error: `gog ${label} returned output that is not JSON` };
      }
    },
  };
}

export function isReadOnly(op: GogOp): boolean {
  return READ_ONLY_KINDS.has(op.kind);
}
