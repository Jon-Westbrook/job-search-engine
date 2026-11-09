import { api } from '../api.ts';
import type { Decide } from './RowActions.tsx';

export const DONE: Record<Decide, string> = {
  progress: 'saved to Analysis',
  applied: 'marked applied',
  not_interested: 'marked not interested',
  not_available: 'marked not available',
  bring_back: 'brought back to Undecided',
  reopen: 'reopened',
};

// Opens the listing. On a phone it opens a new tab. On a computer it opens one small window that is
// reused, so a quick look does not pile up tabs. The owner opens it, not the app.
export function openListing(job: { id: number; url: string }, small: boolean): void {
  if (small) window.open(job.url, '_blank', 'noopener');
  else window.open(job.url, 'autojob-listing', 'popup=yes,width=1040,height=900,noopener');
  api.post(`jobs/${job.id}/listing-opened`, {}).catch(() => undefined);
}

// Applies one decision to one or more jobs. The server checks each job on its own.
export function sendDecision(ids: number[], action: Decide): Promise<{ done: number; failed: number[] }> {
  return api.post<{ done: number; failed: number[] }>('jobs/batch', { ids, action });
}
