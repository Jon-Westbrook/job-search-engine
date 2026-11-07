import type { Band, JobListItem, ResultRow, ResultsResponse } from '../../shared/types.ts';
import { SOURCE_CHANNELS, SOURCE_CHANNEL_KEYS } from '../../shared/channels.ts';
import { decisionOf } from '../../shared/decision.ts';

const BANDS: Array<{ key: string; label: string; band: Band }> = [
  { key: 'good', label: 'Good fit', band: 'good' },
  { key: 'review', label: 'Review', band: 'review' },
  { key: 'low', label: 'Low', band: 'low' },
  { key: 'unscored', label: 'Not scored', band: 'unscored' },
];

// Every job already carries its decision, so the results come from the existing tables with no new
// storage. A job with two channels counts under both. Blocked jobs have no decision and are left out.
export function decisionResults(items: JobListItem[], openedIds: Set<number>): ResultsResponse {
  return {
    by_channel: SOURCE_CHANNEL_KEYS.map((key) => tally(key, SOURCE_CHANNELS[key], items.filter((j) => j.channels.includes(key)), openedIds)),
    by_band: BANDS.map((b) => tally(b.key, b.label, items.filter((j) => j.band === b.band), openedIds)),
  };
}

function tally(key: string, label: string, jobs: JobListItem[], openedIds: Set<number>): ResultRow {
  const row: ResultRow = { key, label, undecided: 0, progressed: 0, not_interested: 0, not_available: 0, opened: 0 };
  for (const job of jobs) {
    const decision = decisionOf(job);
    if (decision === 'blocked') continue;
    if (decision === 'undecided') row.undecided++;
    else if (decision === 'progressed') row.progressed++;
    else if (decision === 'not_interested') row.not_interested++;
    else row.not_available++;
    if (openedIds.has(job.id)) row.opened++;
  }
  return row;
}
