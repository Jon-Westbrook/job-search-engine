import type { Db } from '../db/index.ts';
import type { Logger } from '../log.ts';
import { getThreadMessages, searchThreads, type AlertMessage } from '../gog/gmail.ts';
import type { GogRunner } from '../gog/wrapper.ts';
import { parseLinkedInAlert } from './linkedin.ts';
import { getCursor, setCursor, upsertPosting } from './store.ts';

const DAY_MS = 86_400_000;
const MAX_PAGES = 50;
const MAX_ERRORS_STORED = 50;

export interface SyncSource {
  id: string;
  query: string;
  senders: string[];
  overlap_days: number;
  initial_lookback_days: number;
  parser_version: string;
}

export interface SyncCounts {
  threads: number;
  messages: number;
  skippedNonAlert: number;
  postings: number;
  inserted: number;
  updated: number;
  unchanged: number;
  parseErrors: number;
  fetchErrors: number;
}

export interface SyncError {
  message_id?: string;
  thread_id?: string;
  error: string;
}

export interface SyncResult {
  runId: number;
  status: 'ok' | 'partial' | 'failed';
  counts: SyncCounts;
  errors: SyncError[];
  cursorBefore: string | null;
  cursorAfter: string | null;
}

export interface SyncProgress {
  done: number;
  total: number;
  messages: number;
}

export type RefreshPhase = 'searching' | 'downloading' | 'processing' | 'scoring';

export interface SyncDeps {
  db: Db;
  runner: GogRunner;
  logger: Logger;
  now?: () => Date;
  onProgress?: (p: SyncProgress) => void;
  isCancelled?: () => boolean;
}

// One incremental pass. It reads the search window from the cursor minus the overlap,
// fetches each thread, keeps only messages from configured alert senders, parses them,
// and stores postings idempotently. Partial failures are recorded and never erase data.
export async function runIngestion(deps: SyncDeps, source: SyncSource): Promise<SyncResult> {
  const { db, runner, logger } = deps;
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const cursorBefore = getCursor(db, source.id);

  const started = db
    .prepare(`INSERT INTO sync_runs (source_id, status, started_at, cursor_before) VALUES (?, 'running', ?, ?)`)
    .run(source.id, nowIso, cursorBefore);
  const runId = Number(started.lastInsertRowid);

  const counts: SyncCounts = {
    threads: 0,
    messages: 0,
    skippedNonAlert: 0,
    postings: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    parseErrors: 0,
    fetchErrors: 0,
  };
  const errors: SyncError[] = [];
  const addError = (e: SyncError) => {
    if (errors.length < MAX_ERRORS_STORED) errors.push(e);
  };

  const afterMs = cursorBefore
    ? Date.parse(cursorBefore) - source.overlap_days * DAY_MS
    : now.getTime() - source.initial_lookback_days * DAY_MS;
  const query = `${source.query} after:${Math.floor(afterMs / 1000)}`;

  const threadIds: string[] = [];
  let fatal: string | null = null;
  let page: string | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const result = await searchThreads(runner, query, page);
    if (!result.ok) {
      fatal = result.error;
      break;
    }
    threadIds.push(...result.value.threadIds);
    page = result.value.nextPageToken;
    if (!page) break;
  }
  const uniqueThreads = [...new Set(threadIds)];
  counts.threads = uniqueThreads.length;
  deps.onProgress?.({ done: 0, total: uniqueThreads.length, messages: 0 });

  let newestReceived: string | null = null;
  let fetchFailed = fatal !== null;
  if (fatal) addError({ error: `search failed: ${fatal}` });

  if (!fatal) {
    for (const [index, threadId] of uniqueThreads.entries()) {
      if (deps.isCancelled?.()) {
        addError({ error: 'Cancelled by the owner. Threads not yet read were skipped.' });
        fetchFailed = true;
        break;
      }
      deps.onProgress?.({ done: index, total: uniqueThreads.length, messages: counts.messages });
      const fetched = await getThreadMessages(runner, threadId);
      if (!fetched.ok) {
        fetchFailed = true;
        counts.fetchErrors++;
        addError({ thread_id: threadId, error: fetched.error });
        continue;
      }
      for (const message of fetched.messages) {
        counts.messages++;
        if (!isFromAlertSender(message, source.senders)) {
          counts.skippedNonAlert++;
          continue;
        }
        if (message.receivedAt && (!newestReceived || message.receivedAt > newestReceived)) {
          newestReceived = message.receivedAt;
        }
        handleMessage(db, source, message, nowIso, counts, addError, logger);
      }
    }
  }

  // The cursor moves forward only when every fetch succeeded. A failed fetch leaves the
  // cursor where it was, so the next run re-reads the same window. Re-reads are idempotent.
  let cursorAfter = cursorBefore;
  if (!fetchFailed && newestReceived && (!cursorBefore || newestReceived > cursorBefore)) {
    cursorAfter = newestReceived;
  }
  if (cursorAfter !== cursorBefore && cursorAfter) setCursor(db, source.id, cursorAfter, nowIso);

  const hadProblems = fetchFailed || counts.parseErrors > 0;
  const status: SyncResult['status'] = fatal ? 'failed' : hadProblems ? 'partial' : 'ok';
  db.prepare(`UPDATE sync_runs SET status = ?, finished_at = ?, cursor_after = ?, counts = ?, errors = ? WHERE id = ?`).run(
    status,
    new Date().toISOString(),
    cursorAfter,
    JSON.stringify(counts),
    JSON.stringify(errors),
    runId,
  );
  logger.info('ingestion finished', { source: source.id, run_id: runId, status, counts, cursor_after: cursorAfter });
  return { runId, status, counts, errors, cursorBefore, cursorAfter };
}

function handleMessage(
  db: Db,
  source: SyncSource,
  message: AlertMessage,
  nowIso: string,
  counts: SyncCounts,
  addError: (e: SyncError) => void,
  logger: Logger,
): void {
  if (!message.receivedAt) {
    counts.parseErrors++;
    addError({ message_id: message.id, error: 'message has no received time' });
    return;
  }
  const parsed = parseLinkedInAlert(message);
  for (const err of parsed.errors) {
    counts.parseErrors++;
    addError({ message_id: message.id, error: err.replace(`${message.id}: `, '') });
  }
  for (const posting of parsed.postings) {
    counts.postings++;
    const { outcome } = upsertPosting(db, posting, nowIso, source.parser_version);
    if (outcome === 'inserted') counts.inserted++;
    else if (outcome === 'updated') counts.updated++;
    else counts.unchanged++;
  }
  logger.debug('message processed', { message_id: message.id, postings: parsed.postings.length, errors: parsed.errors.length });
}

export function isFromAlertSender(message: AlertMessage, senders: string[]): boolean {
  const match = /<([^>]+)>/.exec(message.from);
  const address = (match?.[1] ?? message.from).trim().toLowerCase();
  return senders.map((s) => s.toLowerCase()).includes(address);
}
