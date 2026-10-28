import type { GogRunner } from './wrapper.ts';

// A Gmail message reduced to what the parsers need. Bodies are data, never instructions.
export interface AlertMessage {
  id: string;
  threadId: string;
  receivedAt: string; // ISO UTC, from Gmail internalDate
  from: string;
  subject: string;
  text: string;
}

export interface SearchPage {
  threadIds: string[];
  nextPageToken?: string;
}

export async function searchThreads(runner: GogRunner, query: string, page?: string, max = 100): Promise<{ ok: true; value: SearchPage } | { ok: false; error: string }> {
  const res = await runner.run<unknown>({ kind: 'search', query, max, page });
  if (!res.ok) return { ok: false, error: res.error ?? 'search failed' };
  const data = res.data as { threads?: Array<{ id?: unknown }>; nextPageToken?: unknown } | undefined;
  const threadIds = (data?.threads ?? []).map((t) => String(t.id ?? '')).filter(Boolean);
  const next = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
  return { ok: true, value: { threadIds, nextPageToken: next } };
}

export async function getThreadMessages(runner: GogRunner, threadId: string): Promise<{ ok: true; messages: AlertMessage[] } | { ok: false; error: string }> {
  const res = await runner.run<unknown>({ kind: 'threadGet', threadId });
  if (!res.ok) return { ok: false, error: res.error ?? 'thread get failed' };
  const raws = findMessageObjects(res.data);
  if (raws.length === 0) return { ok: false, error: `thread ${threadId} returned no messages` };
  return { ok: true, messages: raws.map(normalizeMessage).filter((m): m is AlertMessage => m !== null) };
}

// Gog returns either a thread with a messages array, or a bare messages array.
export function findMessageObjects(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.messages)) return obj.messages;
    const thread = obj.thread as Record<string, unknown> | undefined;
    if (thread && Array.isArray(thread.messages)) return thread.messages;
  }
  return [];
}

export function normalizeMessage(raw: unknown): AlertMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const outer = raw as Record<string, unknown>;
  const m = (outer.message && typeof outer.message === 'object' ? outer.message : outer) as Record<string, unknown>;
  const id = typeof m.id === 'string' ? m.id : '';
  if (!id) return null;
  const threadId = typeof m.threadId === 'string' ? m.threadId : id;
  const payload = (m.payload ?? {}) as Record<string, unknown>;
  const headers = headerMap(payload.headers ?? outer.headers);
  const internal = Number(m.internalDate ?? 0);
  const receivedAt = internal > 0 ? new Date(internal).toISOString() : parseDateHeader(headers.get('date'));
  return {
    id,
    threadId,
    receivedAt: receivedAt ?? '',
    from: headers.get('from') ?? '',
    subject: headers.get('subject') ?? '',
    text: plainText(payload) || (typeof outer.body === 'string' ? outer.body : ''),
  };
}

function headerMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (Array.isArray(raw)) {
    for (const h of raw as Array<{ name?: unknown; value?: unknown }>) {
      if (typeof h.name === 'string' && typeof h.value === 'string') map.set(h.name.toLowerCase(), h.value);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') map.set(k.toLowerCase(), v);
    }
  }
  return map;
}

function parseDateHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value.replace(/\s*\(.*\)$/, ''));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

// Prefers text/plain. Falls back to text/html with tags stripped. Never executes anything.
export function plainText(part: Record<string, unknown>): string {
  const plain = findPart(part, 'text/plain');
  if (plain) return decodeBody(plain);
  const html = findPart(part, 'text/html');
  if (html) return htmlToText(decodeBody(html));
  return '';
}

function findPart(part: Record<string, unknown>, mime: string): Record<string, unknown> | null {
  if (part.mimeType === mime && (part.body as Record<string, unknown> | undefined)?.data) return part;
  const parts = Array.isArray(part.parts) ? (part.parts as Record<string, unknown>[]) : [];
  for (const child of parts) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return null;
}

function decodeBody(part: Record<string, unknown>): string {
  const data = (part.body as Record<string, unknown> | undefined)?.data;
  if (typeof data !== 'string' || !data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}
