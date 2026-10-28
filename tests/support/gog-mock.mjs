#!/usr/bin/env node
// Test double for the Gog CLI. Serves the sanitized fixtures and logs every call.
// Write commands are refused with exit 3, and each attempt is logged for assertions.
import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = process.env.MOCK_GOG_FIXTURES || join(here, '..', '..', 'fixtures', 'linkedin');
const logFile = process.env.MOCK_GOG_LOG || '';
const args = process.argv.slice(2);

function log(entry) {
  if (logFile) appendFileSync(logFile, JSON.stringify(entry) + '\n');
}

function gmailShape(m) {
  const data = Buffer.from(m.text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    id: m.id,
    threadId: m.threadId,
    internalDate: String(m.internalDate),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: m.headers.From },
        { name: 'Subject', value: m.headers.Subject },
        { name: 'Date', value: m.headers.Date },
      ],
      parts: [{ mimeType: 'text/plain', headers: [], body: { data } }],
    },
  };
}

function loadThreads() {
  const threads = [];
  for (const f of readdirSync(fixtureDir).filter((x) => x.endsWith('.json')).sort()) {
    const doc = JSON.parse(readFileSync(join(fixtureDir, f), 'utf8'));
    if (doc.kind === 'thread') threads.push({ id: doc.thread.id, messages: doc.thread.messages });
    else threads.push({ id: doc.message.threadId, messages: [doc.message] });
  }
  return threads;
}

const write = args.some((a) => ['send', 'modify', 'trash', 'archive', 'label', 'untrash', 'spam'].includes(a)) ||
  (args[0] === 'gmail' && args[1] === 'thread' && args[2] === 'modify');
if (write) {
  log({ argv: args, refused: true });
  process.stderr.write('refused: write commands are not allowed in this mock\n');
  process.exit(3);
}

const readOk = (args[0] === 'gmail' && args[1] === 'search') ||
  (args[0] === 'gmail' && args[1] === 'thread' && args[2] === 'get') ||
  (args[0] === 'gmail' && args[1] === 'labels' && args[2] === 'list');
log({ argv: args, refused: !readOk });
if (!readOk) {
  process.stderr.write('unsupported in mock\n');
  process.exit(2);
}

const threadsAll = loadThreads();

if (args[1] === 'search') {
  const query = args[2] || '';
  const after = Number((/after:(\d+)/.exec(query) || [])[1] || 0) * 1000;
  const pageAt = args.indexOf('--page');
  const page = pageAt >= 0 ? Number(args[pageAt + 1]) : 0;
  const matching = threadsAll.filter((t) => t.messages.some((m) => m.internalDate >= after));
  const size = 2;
  const slice = matching.slice(page * size, page * size + size);
  const more = (page + 1) * size < matching.length;
  process.stdout.write(JSON.stringify({
    count: slice.length,
    has_more: more,
    nextPageToken: more ? String(page + 1) : '',
    threads: slice.map((t) => ({ id: t.id, messageCount: t.messages.length })),
  }));
  process.exit(0);
}

if (args[1] === 'thread' && args[2] === 'get') {
  const id = args[3];
  if (process.env.MOCK_GOG_FAIL_THREAD && process.env.MOCK_GOG_FAIL_THREAD === id) {
    process.stderr.write('transient failure from the mock\n');
    process.exit(1);
  }
  const t = threadsAll.find((x) => x.id === id);
  if (!t) {
    process.stderr.write('thread not found\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ thread: { id: t.id, messages: t.messages.map(gmailShape) } }));
  process.exit(0);
}

if (args[1] === 'labels' && args[2] === 'list') {
  process.stdout.write(JSON.stringify({ labels: [{ id: 'INBOX', name: 'INBOX' }, { id: 'UNREAD', name: 'UNREAD' }, { id: 'LinkedIn', name: 'LinkedIn' }] }));
  process.exit(0);
}
