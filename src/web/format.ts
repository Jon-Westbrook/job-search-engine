// Display helpers. Times are shown in America/New_York. Copy is plain, with no em dashes.
const NY = 'America/New_York';

export function clock(iso: string | null): string {
  if (!iso) return 'Not yet';
  return new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

export function shortDate(iso: string | null): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', { timeZone: NY, month: 'short', day: 'numeric' }).format(new Date(iso));
}

// Posted age for the table: 2h, 3d, or a date after two weeks. Missing stays "Not stated".
export function postedLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Not stated';
  const ageHours = (now - Date.parse(iso)) / 3_600_000;
  if (ageHours < 0) return 'Now';
  if (ageHours < 48) return `${Math.max(1, Math.round(ageHours))}h`;
  if (ageHours < 24 * 14) return `${Math.round(ageHours / 24)}d`;
  return shortDate(iso);
}

// Estimated times (from the alert date) carry a suffix, so they are never read as stated.
export function postedText(job: { posted_at: string | null; posted_estimated: boolean }): string {
  const label = postedLabel(job.posted_at);
  return job.posted_estimated ? `${label} est.` : label;
}

export function postedFull(iso: string | null): string {
  if (!iso) return 'Posting time not stated';
  return `Posted ${shortDate(iso)}`;
}

export function confidenceWord(c: string | null): string {
  if (c === 'high') return 'High confidence';
  if (c === 'medium') return 'Medium confidence';
  if (c === 'low') return 'Low confidence';
  return 'Not scored';
}

export function arrangementWord(a: string | null): string {
  if (a === 'onsite') return 'On-site';
  if (a === 'hybrid') return 'Hybrid';
  if (a === 'remote') return 'Remote';
  return 'Not stated';
}

export function scoreAnnouncement(score: number | null, confidence: string | null): string {
  if (score === null) return 'Not scored yet';
  return `Score ${score} of 100, ${confidence ?? 'unknown'} confidence`;
}

export function reasonText(reason: string): string {
  return reason.replace(/_/g, ' ');
}
