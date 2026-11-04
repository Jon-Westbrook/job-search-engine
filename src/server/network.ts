import type { Db } from './db/index.ts';
import { listJobs } from './jobs/read.ts';
import type { NetworkContact, NetworkJob, NetworkRow, OutreachRecord } from '../shared/types.ts';
import { personKey } from '../shared/person.ts';
import { listOutreach } from './outreach.ts';

// The Network view: people you know, grouped by the company they work at, with the open jobs
// at that company ranked by score. Contacts come from config/contacts.local.json. Nothing here
// sends a message, and the drafts are fixed templates, not AI output.

// Stronger relationships first. The Direct line tiers use the same ordering.
const RELATIONSHIP_RANK: Record<string, number> = {
  friend: 0,
  referral: 1,
  'former employer': 2,
  recruiter: 3,
  'former colleague': 4,
  alumni: 5,
  connection: 6,
};

const JOBS_SHOWN = 3;

export function buildNetwork(db: Db, nowIso: string = new Date().toISOString()): NetworkRow[] {
  const contacts = db
    .prepare('SELECT name, company, company_key, relationship, profile_url, position FROM contacts WHERE company_key IS NOT NULL ORDER BY name')
    .all() as Array<{ name: string; company: string; company_key: string; relationship: string | null; profile_url: string | null; position: string | null }>;
  if (contacts.length === 0) return [];

  const jobKeys = new Map(
    (db.prepare('SELECT id, company_key FROM jobs').all() as Array<{ id: number; company_key: string | null }>).map((r) => [r.id, r.company_key]),
  );
  const jobUrls = new Map((db.prepare('SELECT id, canonical_url FROM jobs').all() as Array<{ id: number; canonical_url: string }>).map((r) => [r.id, r.canonical_url]));
  const targets = new Map((db.prepare('SELECT company_key, name FROM targets').all() as Array<{ company_key: string; name: string }>).map((r) => [r.company_key, r.name]));
  // Open jobs only: not blocked, not rule-blocked, not closed on LinkedIn.
  const openJobs = listJobs(db, { filter: 'all', direct: 'any', sort: 'score' }).items;
  const outreach = listOutreach(db, nowIso);

  const byKey = new Map<string, { company: string; contacts: NetworkContact[] }>();
  for (const c of contacts) {
    const row = byKey.get(c.company_key) ?? { company: c.company, contacts: [] };
    row.contacts.push({ key: personKey(c.name, c.company_key, c.profile_url), name: c.name, relationship: c.relationship ?? 'connection', profile_url: c.profile_url, position: c.position });
    byKey.set(c.company_key, row);
  }

  const rows: NetworkRow[] = [];
  for (const [key, group] of byKey) {
    group.contacts.sort((a, b) => (RELATIONSHIP_RANK[a.relationship] ?? 9) - (RELATIONSHIP_RANK[b.relationship] ?? 9) || a.name.localeCompare(b.name));
    const jobs = openJobs
      .filter((j) => jobKeys.get(j.id) === key)
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.id - b.id);
    rows.push({
      company: group.company,
      target: targets.get(key) ?? null,
      contacts: group.contacts,
      jobs: jobs.slice(0, JOBS_SHOWN).map((j) => ({
        id: j.id,
        title: j.title,
        url: jobUrls.get(j.id) ?? '',
        location: j.location,
        score: j.score,
        band: j.band,
        posted_at: j.posted_at,
        posted_estimated: j.posted_estimated,
      })),
      job_count: jobs.length,
      best_score: jobs[0]?.score ?? null,
      outreach: outreach.filter((o: OutreachRecord) => o.company_key === key),
    });
  }

  // Companies with a fitting job come first, then the best-scored, then the most contacts.
  rows.sort(
    (a, b) =>
      (b.job_count > 0 ? 1 : 0) - (a.job_count > 0 ? 1 : 0) ||
      (b.best_score ?? -1) - (a.best_score ?? -1) ||
      b.contacts.length - a.contacts.length ||
      a.company.localeCompare(b.company),
  );
  return rows;
}
