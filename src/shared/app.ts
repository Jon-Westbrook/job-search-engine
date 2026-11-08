// The product name is a placeholder. Change it here only.
export const APP_NAME = 'AUTOJOB';

export const API_VERSION = 'v1';
export const EXPORT_SCHEMA_VERSION = 1;

// Scoring bands from brief section 8.6. Starting values, configurable in code.
export const GOOD_FIT_THRESHOLD = 65;
export const REVIEW_THRESHOLD = 50;
export const RULE_BLOCK_CAP = 5;

// Undo window for Block, from brief section 12.2 and section 19.
export const BLOCK_UNDO_WINDOW_MS = 5000;
// An outreach message with no reply is due for a follow-up after this many days.
export const FOLLOW_UP_DAYS = 7;

// Postings with a stated date older than this are not stored. Without the limit, deleted old jobs
// come back as new on the next refresh.
export const MAX_POSTING_AGE_DAYS = 7;

export function postedTooOld(postedAt: string | null, nowIso: string): boolean {
  return postedAt !== null && Date.parse(nowIso) - Date.parse(postedAt) > MAX_POSTING_AGE_DAYS * 86_400_000;
}
