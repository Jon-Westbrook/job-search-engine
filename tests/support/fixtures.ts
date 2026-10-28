import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeMessage, type AlertMessage } from '../../src/server/gog/gmail.ts';

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'linkedin');

interface FixtureMessage {
  id: string;
  threadId: string;
  internalDate: number;
  headers: { From: string; Subject: string; Date: string };
  text: string;
}

type FixtureDoc = { kind: 'message'; message: FixtureMessage } | { kind: 'thread'; thread: { id: string; messages: FixtureMessage[] } };

export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
}

export function loadFixtureDoc(name: string): FixtureDoc {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8')) as FixtureDoc;
}

// Rebuilds the Gmail API message shape that Gog returns, so the normalizer is exercised
// the same way it is in production (headers in payload, text in a base64url body part).
export function toGmailShape(m: FixtureMessage): unknown {
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

export function fixtureMessages(name: string): AlertMessage[] {
  const doc = loadFixtureDoc(name);
  const raw = doc.kind === 'thread' ? doc.thread.messages : [doc.message];
  return raw.map((m) => normalizeMessage(toGmailShape(m))).filter((m): m is AlertMessage => m !== null);
}
