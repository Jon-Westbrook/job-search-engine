import { execFile, spawn as execFileSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTRACTION_SCHEMA } from './extract.ts';

// Runs the Codex CLI with the ChatGPT sign-in already stored for it. The pattern follows
// the other apps on the host: read-only sandbox, ephemeral session, strict output schema.
// Output is read from a file. Prompt text and output are never logged.

export interface CodexStatus {
  available: boolean;
  detail: string;
}

export interface ExtractCall {
  ok: true;
  json: unknown;
  model: string;
  reasoningEffort: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

export interface CodexRunner {
  status(): Promise<CodexStatus>;
  extract(prompt: string): Promise<ExtractCall | { ok: false; error: string }>;
  readonly model: string;
  readonly reasoningEffort: string;
}

export type CodexExec = (file: string, args: string[], input: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string; code: number; timedOut: boolean }>;

const defaultExec: CodexExec = (file, args, input, timeoutMs) =>
  new Promise((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed && (err as { signal?: string }).signal === 'SIGTERM');
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code, timedOut });
    });
    child.stdin?.end(input);
  });

export interface CodexOptions {
  bin: string;
  model: string;
  reasoningEffort: string;
  timeoutMs: number;
  exec?: CodexExec;
}

export function createCodexRunner(opts: CodexOptions): CodexRunner {
  const exec = opts.exec ?? defaultExec;
  return {
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,

    async status(): Promise<CodexStatus> {
      const res = await exec(opts.bin, ['login', 'status'], '', 10_000);
      const text = `${res.stdout}\n${res.stderr}`;
      if (res.code === 0 && /logged in/i.test(text)) return { available: true, detail: 'Signed in with ChatGPT' };
      return { available: false, detail: 'Not signed in to ChatGPT for the Codex CLI' };
    },

    async extract(prompt: string) {
      const dir = mkdtempSync(join(tmpdir(), 'jse-codex-'));
      try {
        const schemaPath = join(dir, 'schema.json');
        const outPath = join(dir, 'output.json');
        writeFileSync(schemaPath, JSON.stringify(EXTRACTION_SCHEMA));
        const args = [
          'exec',
          '--ephemeral',
          '--ignore-rules',
          '--sandbox',
          'read-only',
          '--skip-git-repo-check',
          '--model',
          opts.model,
          '--config',
          `model_reasoning_effort="${opts.reasoningEffort}"`,
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outPath,
          '--cd',
          dir,
          '-',
        ];
        const res = await exec(opts.bin, args, prompt, opts.timeoutMs);
        if (res.timedOut) return { ok: false, error: 'The AI provider timed out' };
        if (res.code !== 0) return { ok: false, error: `The AI provider failed (exit ${res.code})` };
        let json: unknown;
        try {
          json = JSON.parse(readFileSync(outPath, 'utf8'));
        } catch {
          return { ok: false, error: 'The AI provider did not return JSON' };
        }
        return { ok: true, json, model: opts.model, reasoningEffort: opts.reasoningEffort, tokensIn: null, tokensOut: null };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

// Parses the device-login output: the sign-in URL and the one-time code. Pure, so it can
// be tested without starting a process.
export function parseDeviceLogin(text: string): { url: string | null; code: string | null } {
  const url = /https?:\/\/\S+/.exec(text)?.[0] ?? null;
  const code = /\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/.exec(text)?.[1] ?? null;
  return { url, code };
}

export interface DeviceLoginStart {
  url: string;
  code: string;
  steps: string[];
}

// Starts `codex login --device-auth` and returns the URL and code. The owner signs in in
// their own browser. The process stays alive until sign-in completes or it times out.
export function startDeviceLogin(bin: string, timeoutMs = 15_000): Promise<DeviceLoginStart | { error: string }> {
  return new Promise((resolve) => {
    let buffer = '';
    const child = execFileSpawn(bin, ['login', '--device-auth']);
    const done = (value: DeviceLoginStart | { error: string }) => {
      clearTimeout(timer);
      resolve(value);
    };
    const onChunk = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const parsed = parseDeviceLogin(buffer);
      if (parsed.url && parsed.code) {
        done({
          url: parsed.url,
          code: parsed.code,
          steps: [
            'Open the link in your own browser and sign in to ChatGPT.',
            'Enter the code shown here when the page asks for it.',
            'Come back here and press Check sign-in.',
          ],
        });
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('error', () => done({ error: 'The Codex CLI could not start' }));
    const timer = setTimeout(() => {
      child.kill();
      done({ error: 'Codex did not print a sign-in link in time. Try again.' });
    }, timeoutMs);
  });
}

