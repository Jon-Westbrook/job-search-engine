import type { Db } from '../db/index.ts';
import { normalizeCompany, normalizeTitle } from '../normalize/keys.ts';
import type { PlanSummary, PlannedRow } from './import-plan.ts';

export interface ImportResult {
  inserted: number;
  skipped_already_imported: number;
  uncertain: number;
}

// Writes planned rows into the Tracker. Re-running is safe: a row with the same source
// path, line, and content hash is skipped. The log itself is never touched.
export function applyImport(db: Db, plan: PlanSummary, nowIso: string, aliases: Record<string, string> = {}): ImportResult {
  const result: ImportResult = { inserted: 0, skipped_already_imported: 0, uncertain: 0 };
  db.exec('BEGIN');
  try {
    for (const row of plan.rows) {
      const seen = db
        .prepare('SELECT id FROM imports WHERE source_path = ? AND source_line = ? AND content_hash = ?')
        .get(row.source_path, row.source_line, row.content_hash);
      if (seen) {
        result.skipped_already_imported++;
        continue;
      }
      insertRow(db, row, nowIso, aliases);
      result.inserted++;
      if (row.uncertain) result.uncertain++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

function insertRow(db: Db, row: PlannedRow, nowIso: string, aliases: Record<string, string>): void {
  const companyKey = normalizeCompany(row.company, aliases) ?? row.company.toLowerCase();
  const titleKey = normalizeTitle(row.title) ?? 'not recorded';
  const stage = row.status === 'saved' ? 'analysis' : 'tracked';
  const reasonText = row.reasons.length ? ` Needs review: ${row.reasons.join('; ')}.` : '';
  const notes = `Imported from the job-search log at ${row.source_path}, line ${row.source_line}.${row.raw_status ? ` Raw status: ${row.raw_status}.` : ''}${reasonText}`;
  const app = db
    .prepare(
      `INSERT INTO applications (company, company_key, title, title_key, status, stage, applied_at, source_channel, notes, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)`,
    )
    .run(row.company, companyKey, row.title, titleKey, row.status, stage, row.applied_at, row.channel, notes, nowIso, nowIso);
  const applicationId = Number(app.lastInsertRowid);
  db.prepare(
    `INSERT INTO application_events (application_id, type, from_value, to_value, note, created_at) VALUES (?, 'imported', NULL, ?, ?, ?)`,
  ).run(applicationId, row.status, `From the job-search log. ${row.uncertain ? 'Marked uncertain.' : 'No open questions.'}`, nowIso);
  db.prepare(
    `INSERT INTO imports (source_path, source_line, content_hash, raw_date, parsed_date, status, application_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.source_path, row.source_line, row.content_hash, row.raw_date, row.applied_at, row.uncertain ? 'uncertain' : 'ok', applicationId, nowIso);
}
