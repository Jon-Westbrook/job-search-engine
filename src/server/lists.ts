import { readFileSync, existsSync } from 'node:fs';
import type { Db } from './db/index.ts';
import { normalizeCompany } from './normalize/keys.ts';
import { CONTACT_RELATIONSHIPS } from './contacts.ts';

// Personal lists live in gitignored files: the target companies and the contacts.
// Both are read at startup and on each refresh. Nothing is inferred or scraped.

export interface TargetEntry {
  name: string;
  group?: string;
}

export class ListError extends Error {}

export function loadTargetFile(path: string): TargetEntry[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { targets?: unknown };
  if (!Array.isArray(raw.targets)) throw new ListError(`${path}: "targets" must be a list`);
  return raw.targets.map((item, i) => {
    if (typeof item === 'string' && item.trim()) return { name: item.trim() };
    if (item && typeof item === 'object' && typeof (item as TargetEntry).name === 'string' && (item as TargetEntry).name.trim()) {
      const entry = item as TargetEntry;
      return { name: entry.name.trim(), group: entry.group?.trim() || undefined };
    }
    throw new ListError(`${path}: target ${i + 1} needs a name`);
  });
}

// Replaces the whole target table. A group (for example Omnicom) is a target too, so a job
// listed under the group name is tagged.
export function syncTargets(db: Db, entries: TargetEntry[], aliases: Record<string, string>, nowIso: string): number {
  const rows = new Map<string, { name: string; group: string | null }>();
  for (const entry of entries) {
    const key = normalizeCompany(entry.name, aliases) ?? entry.name.toLowerCase();
    rows.set(key, { name: entry.name, group: entry.group ?? null });
    if (entry.group) {
      const groupKey = normalizeCompany(entry.group, aliases) ?? entry.group.toLowerCase();
      if (!rows.has(groupKey)) rows.set(groupKey, { name: entry.group, group: null });
    }
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM targets').run();
    const insert = db.prepare('INSERT INTO targets (company_key, name, group_name, updated_at) VALUES (?, ?, ?, ?)');
    for (const [key, row] of rows) insert.run(key, row.name, row.group, nowIso);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.size;
}

export interface ContactFileEntry {
  name: string;
  company: string;
  relationship: string;
  channel?: string;
}

export const CONTACTS_PROVENANCE = 'contacts file';

// Replaces the contacts that came from the file. Contacts entered in other ways are not touched.
export function syncContactsFromFile(db: Db, path: string, aliases: Record<string, string>, nowIso: string): number {
  if (!existsSync(path)) return 0;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { contacts?: unknown };
  if (!Array.isArray(raw.contacts)) throw new ListError(`${path}: "contacts" must be a list`);
  const entries = raw.contacts.map((item, i): ContactFileEntry => {
    const c = item as Partial<ContactFileEntry>;
    if (!c || typeof c.name !== 'string' || !c.name.trim()) throw new ListError(`${path}: contact ${i + 1} needs a name`);
    if (typeof c.company !== 'string' || !c.company.trim()) throw new ListError(`${path}: contact ${i + 1} needs a company`);
    if (!(CONTACT_RELATIONSHIPS as readonly string[]).includes(String(c.relationship))) {
      throw new ListError(`${path}: contact ${i + 1} relationship must be one of: ${CONTACT_RELATIONSHIPS.join(', ')}`);
    }
    return { name: c.name.trim(), company: c.company.trim(), relationship: String(c.relationship), channel: c.channel };
  });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM contacts WHERE provenance = ?').run(CONTACTS_PROVENANCE);
    const insert = db.prepare(
      'INSERT INTO contacts (name, company, company_key, relationship, channel, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const e of entries) {
      const key = normalizeCompany(e.company, aliases) ?? e.company.toLowerCase();
      insert.run(e.name, e.company, key, e.relationship, e.channel ?? null, CONTACTS_PROVENANCE, nowIso);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return entries.length;
}
