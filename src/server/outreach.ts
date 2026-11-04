import type { Db } from './db/index.ts';
import { ActionError } from './jobs/actions.ts';
import { FOLLOW_UP_DAYS } from '../shared/app.ts';
import { personKey } from '../shared/person.ts';
import type { OutreachRecord } from '../shared/types.ts';

// Messages sent to people about a role. The app never sends or reads LinkedIn; the owner marks
// each step by hand. A record is never deleted: a dropped one stays visible in the Follow-up tab.

export type OutreachAction = 'followed_up' | 'replied' | 'referred' | 'dropped';
const ACTIONS: OutreachAction[] = ['followed_up', 'replied', 'referred', 'dropped'];
const DAY_MS = 86_400_000;

interface OutreachRow {
  id: number;
  person_key: string;
  person_name: string;
  person_url: string | null;
  company: string;
  company_key: string;
  job_id: number | null;
  job_title: string | null;
  job_url: string | null;
  status: OutreachRecord['status'];
  sent_at: string;
  last_contact_at: string;
  followups: number;
}

function toRecord(row: OutreachRow, nowIso: string): OutreachRecord {
  const days = Math.floor((Date.parse(nowIso) - Date.parse(row.last_contact_at)) / DAY_MS);
  return {
    id: row.id,
    person_key: row.person_key,
    person_name: row.person_name,
    person_url: row.person_url,
    company: row.company,
    company_key: row.company_key,
    job_id: row.job_id,
    job_title: row.job_title,
    job_url: row.job_url,
    status: row.status,
    sent_at: row.sent_at,
    last_contact_at: row.last_contact_at,
    followups: row.followups,
    days,
    due: row.status === 'sent' && days >= FOLLOW_UP_DAYS,
  };
}

// Finds the contact by the person key, so the saved name, address, and company come from the
// contacts list, not from the browser.
export function recordOutreach(db: Db, input: { person_key: string; job_id: number | null }, nowIso: string): number {
  const contacts = db.prepare('SELECT name, company, company_key, profile_url FROM contacts WHERE company_key IS NOT NULL').all() as Array<{
    name: string;
    company: string;
    company_key: string;
    profile_url: string | null;
  }>;
  const contact = contacts.find((c) => personKey(c.name, c.company_key, c.profile_url) === input.person_key);
  if (!contact) throw new ActionError(404, 'That person is not in the contacts list');

  let jobTitle: string | null = null;
  if (input.job_id !== null) {
    const job = db.prepare('SELECT title FROM jobs WHERE id = ?').get(input.job_id) as { title: string } | undefined;
    if (!job) throw new ActionError(404, 'That job was not found');
    jobTitle = job.title;
  }

  const existing = db
    .prepare('SELECT id FROM outreach WHERE person_key = ? AND (job_id IS ? OR job_id = ?)')
    .get(input.person_key, input.job_id, input.job_id);
  if (existing) throw new ActionError(409, 'Already asked this person about this role');

  const result = db
    .prepare(
      `INSERT INTO outreach (person_key, person_name, person_url, company, company_key, job_id, job_title, status, sent_at, last_contact_at, followups, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, 0, ?)`,
    )
    .run(input.person_key, contact.name, contact.profile_url, contact.company, contact.company_key, input.job_id, jobTitle, nowIso, nowIso, nowIso);
  return Number(result.lastInsertRowid);
}

export function updateOutreach(db: Db, id: number, action: string, nowIso: string): void {
  if (!ACTIONS.includes(action as OutreachAction)) throw new ActionError(400, 'Unknown outreach action');
  const row = db.prepare('SELECT status FROM outreach WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new ActionError(404, 'Outreach record not found');
  if (action === 'followed_up') {
    if (row.status !== 'sent') throw new ActionError(409, 'Only a message still waiting for a reply can be followed up');
    db.prepare('UPDATE outreach SET last_contact_at = ?, followups = followups + 1, updated_at = ? WHERE id = ?').run(nowIso, nowIso, id);
    return;
  }
  const status = action === 'dropped' ? 'dropped' : action === 'replied' ? 'replied' : 'referred';
  db.prepare('UPDATE outreach SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso, id);
}

export function listOutreach(db: Db, nowIso: string): OutreachRecord[] {
  const rows = db
    .prepare('SELECT o.*, j.canonical_url AS job_url FROM outreach o LEFT JOIN jobs j ON j.id = o.job_id ORDER BY o.last_contact_at ASC, o.id ASC')
    .all() as unknown as OutreachRow[];
  return rows.map((r) => toRecord(r, nowIso));
}

// Role names that someone was asked about, for the Inbox tag. Dropped ones do not count.
export function askedFor(db: Db, jobId: number): string[] {
  const rows = db
    .prepare("SELECT person_name FROM outreach WHERE job_id = ? AND status != 'dropped' ORDER BY id")
    .all(jobId) as Array<{ person_name: string }>;
  return rows.map((r) => r.person_name);
}
