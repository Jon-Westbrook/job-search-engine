import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

test('the alert sender list names only the job-alert sender', () => {
  const cfg = JSON.parse(readFileSync(join(root, 'config', 'sources.json'), 'utf8')) as { sources: Array<{ senders: string[]; query: string }> };
  const source = cfg.sources[0];
  assert.ok(source);
  assert.deepEqual(source.senders, ['jobalerts-noreply@linkedin.com']);
  assert.match(source.query, /jobalerts-noreply@linkedin\.com/);
});

test('no source file issues an HTTP request outside the guard', () => {
  const files = ['src/server/gog/wrapper.ts', 'src/server/gog/gmail.ts', 'src/server/ingest/sync.ts', 'src/server/ingest/linkedin.ts'];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    assert.equal(/\bfetch\(/.test(text), false, `${f} must not call fetch`);
    assert.equal(/linkedin\.com\/(jobs|in)\/[^'"`]*/.test(text.replace(/jobs\/view\/\$\{jobId\}/g, '')), false, `${f} has no LinkedIn request target`);
  }
});
