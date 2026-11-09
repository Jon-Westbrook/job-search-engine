import type { KeyboardEvent } from 'react';
import type { Filter, JobListItem } from '../../shared/types.ts';
import { SOURCE_CHANNELS } from '../../shared/channels.ts';
import { arrangementWord, postedText, scoreAnnouncement } from '../format.ts';
import { RowActions, type Decide } from './RowActions.tsx';

export type SortKey = 'score' | 'target' | 'posted' | 'company' | 'role' | 'source';
export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export const SORT_KEYS: SortKey[] = ['score', 'target', 'posted', 'company', 'role', 'source'];
const SORT_LABEL: Record<SortKey, string> = { score: 'Score', target: 'Target', posted: 'Posted', company: 'Company', role: 'Role', source: 'Source' };

const VIEW_ACTIONS: Partial<Record<Filter, Decide[]>> = {
  undecided: ['progress', 'not_interested', 'not_available'],
  good: ['progress', 'not_interested', 'not_available'],
  targets: ['progress', 'not_interested', 'not_available'],
  progressed: ['applied', 'not_available'],
  not_interested: ['bring_back', 'not_available'],
  not_available: ['reopen'],
};

// Highest score and newest first. Text columns start A to Z. Targets come first when sorted by Target.
export function defaultDir(key: SortKey): SortState['dir'] {
  return key === 'score' || key === 'posted' ? 'desc' : 'asc';
}

export function sourceText(job: JobListItem): string {
  return job.channels.map((c) => SOURCE_CHANNELS[c]).join(', ');
}

export function sortJobs(jobs: JobListItem[], sort: SortState): JobListItem[] {
  const value = (job: JobListItem): string | number => {
    if (sort.key === 'score') return job.score ?? -1;
    if (sort.key === 'target') return job.target ? 0 : 1;
    if (sort.key === 'posted') return job.posted_at ? Date.parse(job.posted_at) : 0;
    if (sort.key === 'company') return (job.company ?? '').toLowerCase();
    if (sort.key === 'role') return job.title.toLowerCase();
    return sourceText(job).toLowerCase();
  };
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...jobs].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const diff = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    // Within the same target group the best score comes first, then the job id keeps the order stable.
    return sign * diff || (b.score ?? -1) - (a.score ?? -1) || a.id - b.id;
  });
}

// Plain text search over what a row shows.
export function matchesSearch(job: JobListItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [job.title, job.company, job.location, job.target, sourceText(job)].some((v) => (v ?? '').toLowerCase().includes(q));
}

interface ListProps {
  jobs: JobListItem[];
  view: Filter;
  sort: SortState;
  selected: Set<number>;
  onSort: (key: SortKey) => void;
  onPick: (id: number) => void;
  onPickAll: (ids: number[], on: boolean) => void;
  onOpen: (job: JobListItem) => void;
  onDecide: (job: JobListItem, action: Decide) => void;
  small: boolean;
  emptyText: string;
}

// Desktop: one table with the same columns in every view. Phone: cards with the same fields.
// Every row has the checkbox and the row buttons. With several rows selected, a button acts on all of them.
export function JobList(props: ListProps) {
  const { jobs, view, sort, selected, onSort, onPick, onPickAll, onOpen, onDecide, small, emptyText } = props;

  if (jobs.length === 0) {
    return <p className="empty">{emptyText}</p>;
  }

  const moveFocus = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-row-button]'));
    const i = buttons.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    buttons[e.key === 'ArrowDown' ? i + 1 : i - 1]?.focus();
  };

  const ids = jobs.map((j) => j.id);
  const allOn = ids.every((id) => selected.has(id));
  const row = { view, selected, onPick, onOpen, onDecide };

  if (small) {
    return (
      <>
        <div className="cards-head">
          <label className="check-all">
            <input type="checkbox" checked={allOn} onChange={() => onPickAll(ids, !allOn)} />
            All shown
          </label>
          <label className="sort-pick">
            Sort by
            <select value={sort.key} onChange={(e) => onSort(e.target.value as SortKey)}>
              {SORT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {SORT_LABEL[key]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="cards" onKeyDown={moveFocus}>
          {jobs.map((job) => (
            <article key={job.id} className={`card${selected.has(job.id) ? ' sel' : ''}`}>
              <div className="card-top">
                <input type="checkbox" className="pick" aria-label={`Select ${job.title}`} checked={selected.has(job.id)} onChange={() => onPick(job.id)} />
                <div className={`score${job.blocked || job.rule_blocked ? ' blk' : ''}`} aria-label={scoreAnnouncement(job.score, job.confidence)}>
                  {job.score ?? '-'}
                </div>
                <div>
                  <span className="role">{job.title}</span>
                  <p className="sub">
                    {job.company ?? 'Company not stated'}
                    {job.location ? ` · ${job.location}` : ''}
                  </p>
                </div>
              </div>
              <div className="tags">
                {job.target && <span className="tg dir">Target: {job.target}</span>}
                {job.channels.map((c) => (
                  <span key={c} className={`tg${c === 'linkedin' ? ' dir' : ''}`}>
                    {SOURCE_CHANNELS[c]}
                  </span>
                ))}
                {job.asked && <span className="tg yel">{job.asked}</span>}
                <span className="tg">{postedText(job)}</span>
              </div>
              <RowActionsForJob job={job} {...row} />
            </article>
          ))}
        </div>
      </>
    );
  }

  return (
    <div className="list">
      <table onKeyDown={moveFocus}>
        <thead>
          <tr>
            <th scope="col" className="pick-col">
              <input type="checkbox" aria-label="Select all shown" checked={allOn} onChange={() => onPickAll(ids, !allOn)} />
            </th>
            <SortHeader label="Score" column="score" sort={sort} onSort={onSort} />
            <SortHeader label="Target" column="target" sort={sort} onSort={onSort} />
            <SortHeader label="Posted" column="posted" sort={sort} onSort={onSort} />
            <SortHeader label="Company" column="company" sort={sort} onSort={onSort} />
            <SortHeader label="Role" column="role" sort={sort} onSort={onSort} />
            <SortHeader label="Source" column="source" sort={sort} onSort={onSort} />
            <th scope="col">Listing</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const blocked = Boolean(job.blocked || job.rule_blocked);
            return (
              <tr key={job.id} className={selected.has(job.id) ? 'sel' : blocked ? 'blk' : undefined}>
                <td className="pick-col">
                  <input type="checkbox" aria-label={`Select ${job.title}`} checked={selected.has(job.id)} onChange={() => onPick(job.id)} />
                </td>
                <td data-label="Score" aria-label={scoreAnnouncement(job.score, job.confidence)}>
                  <span className={`sc${blocked ? ' blk' : ''}`}>{job.score ?? '-'}</span>
                </td>
                <td data-label="Target">{job.target ? <span className="tg dir">{job.target}</span> : <span className="sub">-</span>}</td>
                <td data-label="Posted">{postedText(job)}</td>
                <td data-label="Company">
                  {job.company ?? 'Company not stated'}
                  {job.asked && <p className="sub">{job.asked}</p>}
                </td>
                <td data-label="Role">
                  <span className="role">{job.title}</span>
                  <p className="sub">{[job.location, arrangementWord(job.arrangement)].filter(Boolean).join(' · ') || 'Where not stated'}</p>
                </td>
                <td data-label="Source">
                  {job.channels.map((c) => (
                    <span key={c} className={`tg${c === 'linkedin' ? ' dir' : ''}`}>
                      {SOURCE_CHANNELS[c]}
                    </span>
                  ))}
                </td>
                <td data-label="Listing">
                  <RowActionsForJob job={job} {...row} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader(props: { label: string; column: SortKey; sort: SortState; onSort: (key: SortKey) => void }) {
  const { label, column, sort, onSort } = props;
  const active = sort.key === column;
  return (
    <th scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-btn" onClick={() => onSort(column)}>
        {label}
        {active && (sort.dir === 'asc' ? ' ▲' : ' ▼')}
      </button>
    </th>
  );
}

interface RowProps {
  job: JobListItem;
  view: Filter;
  selected: Set<number>;
  onPick: (id: number) => void;
  onOpen: (job: JobListItem) => void;
  onDecide: (job: JobListItem, action: Decide) => void;
}

// Not available sits right after Open listing, whichever view the row is in.
function orderedActions(view: Filter): Decide[] {
  const actions = VIEW_ACTIONS[view] ?? [];
  return [...actions.filter((a) => a === 'not_available'), ...actions.filter((a) => a !== 'not_available')];
}

function RowActionsForJob(props: RowProps) {
  const { job, view, selected, onOpen, onDecide } = props;
  const blocked = Boolean(job.blocked || job.rule_blocked);
  const count = selected.has(job.id) && selected.size > 1 ? selected.size : 0;
  return <RowActions actions={blocked ? [] : orderedActions(view)} count={count} onOpen={() => onOpen(job)} onDecide={(action) => onDecide(job, action)} />;
}
