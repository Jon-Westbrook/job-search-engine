import type { Db } from './db/index.ts';
import { normalizeCompany } from './normalize/keys.ts';

// Contacts are entered by hand. The app never infers, imports, or scrapes one (brief 8.3).
export const CONTACT_RELATIONSHIPS = ['recruiter', 'former employer', 'friend', 'referral', 'alumni', 'former colleague', 'connection'] as const;
const TIER1 = new Set(['recruiter', 'former employer', 'friend', 'referral']);
const TIER2 = new Set(['alumni', 'former colleague', 'connection']);

export interface ContactInput {
  name: string;
  company: string;
  relationship: string;
  channel?: string | null;
  provenance?: string | null;
}

export class ContactError extends Error {}

export function createContact(db: Db, input: ContactInput, nowIso: string, aliases: Record<string, string> = {}): number {
  if (!input.name.trim()) throw new ContactError('A contact needs a name');
  if (!input.company.trim()) throw new ContactError('A contact needs a company');
  if (!(CONTACT_RELATIONSHIPS as readonly string[]).includes(input.relationship)) {
    throw new ContactError(`Relationship must be one of: ${CONTACT_RELATIONSHIPS.join(', ')}`);
  }
  const companyKey = normalizeCompany(input.company, aliases) ?? input.company.trim().toLowerCase();
  const row = db
    .prepare('INSERT INTO contacts (name, company, company_key, relationship, channel, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(input.name.trim(), input.company.trim(), companyKey, input.relationship, input.channel ?? null, input.provenance ?? null, nowIso);
  return Number(row.lastInsertRowid);
}

export interface UnnamedSignal {
  connections?: number;
  companyAlumni?: number;
  schoolAlumni?: number;
}

// Tier 1: a recruiter or former employer, or a named friend or referral at the company.
// Tier 2: a named alumni or former colleague at the company.
// Tier 3: an unnamed signal from the alert only, such as "1 connection".
// None: no signal.
export function directTierFor(db: Db, companyKey: string | null, signal: UnnamedSignal): 0 | 1 | 2 | 3 {
  if (companyKey) {
    const rows = db.prepare('SELECT relationship FROM contacts WHERE company_key = ?').all(companyKey) as Array<{ relationship: string }>;
    if (rows.some((r) => TIER1.has(r.relationship))) return 1;
    if (rows.some((r) => TIER2.has(r.relationship))) return 2;
  }
  if ((signal.connections ?? 0) > 0 || (signal.companyAlumni ?? 0) > 0 || (signal.schoolAlumni ?? 0) > 0) return 3;
  return 0;
}
