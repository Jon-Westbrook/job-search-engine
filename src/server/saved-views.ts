import type { Db } from './db/index.ts';
import { HttpError } from './http/router.ts';

// A saved view is a named Inbox filter with its search text, such as "Top companies: Omnicom".
export interface SavedView {
  name: string;
  filter: string;
  q: string;
}

const KEY = 'saved_views';
const MAX_VIEWS = 20;

export function savedViews(db: Db): SavedView[] {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    return validateViews(JSON.parse(row.value));
  } catch {
    return [];
  }
}

export function validateViews(value: unknown): SavedView[] {
  if (!Array.isArray(value) || value.length > MAX_VIEWS) throw new HttpError(400, `Keep at most ${MAX_VIEWS} saved views`, 'bad_request');
  return value.map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const filter = typeof o.filter === 'string' ? o.filter : '';
    const q = typeof o.q === 'string' ? o.q.trim() : '';
    if (!name || name.length > 40 || !filter || q.length > 100) throw new HttpError(400, 'A saved view needs a name, a filter, and short search text', 'bad_request');
    return { name, filter, q };
  });
}

export function saveViews(db: Db, views: SavedView[], nowIso: string): void {
  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(KEY, JSON.stringify(views), nowIso);
}
