import { readFileSync, existsSync } from 'node:fs';
import { normalizeCompany, normalizeTitle } from '../normalize/keys.ts';
import { SNAPSHOT_SCHEMA, snapshotHash, type Snapshot, type SnapshotEntry } from './log-snapshot.ts';

// Status mapping (brief section 12.3). Unknown or unclear statuses are kept as saved and
// marked uncertain, with the raw value in the note. Nothing is guessed silently.
export const STATUS_MAP: Record<string, { status: 'saved' | 'applied' | 'interviewing' | 'rejected' | 'offer'; uncertain: boolean }> = {
  planned: { status: 'saved', uncertain: false },
  draft_completed: { status: 'saved', uncertain: false },
  open: { status: 'saved', uncertain: false },
  submitted: { status: 'applied', uncertain: false },
  applied: { status: 'applied', uncertain: false },
  follow_up_sent: { status: 'applied', uncertain: false },
  awaiting_response: { status: 'applied', uncertain: false },
  interview_scheduled: { status: 'interviewing', uncertain: false },
  advancing: { status: 'interviewing', uncertain: false },
  next_steps_identified: { status: 'interviewing', uncertain: false },
  not_selected: { status: 'rejected', uncertain: false },
  closed_not_selected: { status: 'rejected', uncertain: false },
  completed: { status: 'applied', uncertain: true },
  in_progress: { status: 'saved', uncertain: true },
  active: { status: 'saved', uncertain: true },
  recruiter_contact: { status: 'saved', uncertain: true },
  no_role_identified: { status: 'saved', uncertain: true },
  opportunities_identified: { status: 'saved', uncertain: true },
  awaiting_guidance: { status: 'saved', uncertain: true },
  recruiter_screen_scheduled: { status: 'interviewing', uncertain: true },
};

const GENERIC_TITLE = /^(not provided|not recorded|unknown|none|tbd|n\/a)$|multiple|opportunities/i;

export interface PlannedRow {
  source_path: string;
  source_line: number;
  content_hash: string;
  company: string;
  title: string;
  applied_at: string | null;
  raw_date: string | null;
  status: 'saved' | 'applied' | 'interviewing' | 'rejected' | 'offer';
  raw_status: string | null;
  channel: string | null;
  uncertain: boolean;
  reasons: string[];
}

export interface PlanSummary {
  applications_in_log: number;
  rows: PlannedRow[];
  counts: { ok: number; uncertain: number; skipped_non_application: number };
}

// Only type "application" entries become tracker records in Phase 1A. Other types are
// counted and left out. Interviews and follow-ups can feed later phases.
export function planFromSnapshot(snapshot: Snapshot): PlanSummary {
  if (snapshot.schema !== SNAPSHOT_SCHEMA) throw new Error('The log snapshot has an unknown schema');
  const rows: PlannedRow[] = [];
  let skipped = 0;
  for (const entry of snapshot.entries) {
    if (entry.type !== 'application') {
      skipped++;
      continue;
    }
    rows.push(planRow(entry));
  }
  const uncertain = rows.filter((r) => r.uncertain).length;
  return { applications_in_log: rows.length, rows, counts: { ok: rows.length - uncertain, uncertain, skipped_non_application: skipped } };
}

function planRow(entry: SnapshotEntry): PlannedRow {
  const reasons: string[] = [];
  const rawStatus = entry.status;
  const mapped = rawStatus ? STATUS_MAP[rawStatus] : undefined;
  let status: PlannedRow['status'] = 'saved';
  if (!mapped) reasons.push(`status not mapped (${rawStatus ?? 'missing'})`);
  else {
    status = mapped.status;
    if (mapped.uncertain) reasons.push(`status is unclear (${rawStatus})`);
  }
  if (rawStatus && /^sent_on_/.test(rawStatus)) {
    status = 'applied';
    reasons.push(`status is unclear (${rawStatus})`);
  }

  const company = entry.employer ?? '';
  if (!company || !normalizeCompany(company)) reasons.push('company missing');

  const opportunity = entry.opportunity ?? '';
  let title = opportunity;
  if (!opportunity || GENERIC_TITLE.test(opportunity.trim())) {
    title = 'Not recorded';
    reasons.push('role title not recorded');
  }

  let appliedAt: string | null = null;
  if (!entry.event_date) {
    reasons.push('date missing');
  } else {
    appliedAt = entry.event_date;
    if (entry.date_precision !== 'exact') reasons.push(`date is ${entry.date_precision ?? 'not exact'}`);
  }

  return {
    source_path: entry.path,
    source_line: entry.line,
    content_hash: snapshotHash(entry),
    company: company || 'Company not recorded',
    title: normalizeTitle(title) ? title : 'Not recorded',
    applied_at: appliedAt,
    raw_date: entry.event_date,
    status,
    raw_status: rawStatus,
    channel: entry.channel,
    uncertain: reasons.length > 0,
    reasons,
  };
}

export function loadSnapshot(path: string): Snapshot | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}
