import type { KeyboardEvent } from 'react';
import type { JobListItem } from '../../shared/types.ts';
import { arrangementWord, postedText } from '../format.ts';

export type SortKey = 'posted' | 'company' | 'role' | 'where' | 'pay' | 'direct';
export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export const SORT_KEYS: SortKey[] = ['posted', 'company', 'role', 'where', 'pay', 'direct'];
const SORT_LABEL: Record<SortKey, string> = { posted: 'Posted', company: 'Company', role: 'Role', where: 'Where', pay: 'Pay', direct: 'Direct line' };

// Newest and highest pay first. Text columns start A to Z. Direct line starts with the strongest tier.
export function defaultDir(key: SortKey): SortState['dir'] {
  return key === 'posted' || key === 'pay' ? 'desc' : 'asc';
}

export function sortJobs(jobs: JobListItem[], sort: SortState): JobListItem[] {
  const value = (job: JobListItem): string | number => {
    if (sort.key === 'posted') return job.posted_at ? Date.parse(job.posted_at) : 0;
    if (sort.key === 'company') return (job.company ?? '').toLowerCase();
    if (sort.key === 'role') return job.title.toLowerCase();
    if (sort.key === 'where') return (job.location ?? '').toLowerCase();
    if (sort.key === 'pay') return job.pay?.max ?? -1;
    return job.direct_tier === 0 ? 4 : job.direct_tier;
  };
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...jobs].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const diff = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return sign * diff || a.id - b.id;
  });
}

// Flags say what needs a look. They never hide a row.
export function flagTags(job: JobListItem): Array<{ text: string; tone: string }> {
  const tags: Array<{ text: string; tone: string }> = [];
  if (job.rule_blocked) tags.push({ text: 'Blocked by rule', tone: 'red' });
  else if (job.blocked) tags.push({ text: 'Blocked', tone: 'red' });
  if (job.target) tags.push({ text: `Target: ${job.target}`, tone: 'dir' });
  if (job.asked) tags.push({ text: job.asked, tone: 'yel' });
  if (job.applied) tags.push({ text: `Applied ${job.applied.date ?? ''}`.trim(), tone: 'yel' });
  else if (job.in_analysis) tags.push({ text: 'In Analysis', tone: 'dir' });
  if (job.possible_duplicate) tags.push({ text: 'Possible duplicate', tone: 'yel' });
  if (job.source_count > 1) tags.push({ text: `${job.source_count} sources`, tone: '' });
  if (job.tn_label === 'design_centric') tags.push({ text: 'TN inferred', tone: '' });
  else if (job.tn_label === 'explicit') tags.push({ text: 'TN stated', tone: 'dir' });
  if (job.confidence === 'low') tags.push({ text: 'Low confidence', tone: 'yel' });
  for (const f of job.flags.filter((x) => x.startsWith('Review:'))) tags.push({ text: f.replace('Review: ', 'Review, '), tone: 'yel' });
  return tags;
}

export function directTag(job: JobListItem): { text: string; dir: boolean } {
  if (job.direct_tier === 1) return { text: 'Recruiter or former employer', dir: true };
  if (job.direct_tier === 2) return { text: 'Named contact', dir: true };
  if (job.direct_tier === 3) return { text: 'Signal only', dir: false };
  return { text: 'None', dir: false };
}

interface ListProps {
  jobs: JobListItem[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  onOpen: (job: JobListItem) => void;
  onToggleAvailable: (job: JobListItem) => void;
  small: boolean;
  emptyText: string;
}

// Desktop: a table with sortable headers. Phone: cards with the same fields and a sort picker.
// The two row buttons sit on the row itself, so a job is opened or marked without a panel.
export function JobList(props: ListProps) {
  const { jobs, sort, onSort, onOpen, onToggleAvailable, small, emptyText } = props;

  if (jobs.length === 0) {
    return <p className="empty">{emptyText}</p>;
  }

  const moveFocus = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-row-button]'));
    const i = buttons.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next = buttons[e.key === 'ArrowDown' ? i + 1 : i - 1];
    next?.focus();
  };

  if (small) {
    return (
      <>
        <div className="cards-head">
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
          <button type="button" className="pill" onClick={() => onSort(sort.key)}>
            {sort.dir === 'asc' ? 'Ascending' : 'Descending'}
          </button>
        </div>
        <div className="cards" onKeyDown={moveFocus}>
          {jobs.map((job) => (
            <article key={job.id} className={`card${job.blocked || job.rule_blocked ? ' blk' : ''}`}>
              <div className="card-top">
                <div>
                  <span className="role">{job.title}</span>
                  <p className="sub">
                    {job.company ?? 'Company not stated'}
                    {job.arrangement ? ` · ${arrangementWord(job.arrangement)}` : ''}
                  </p>
                </div>
              </div>
              <dl className="card-fields">
                <div>
                  <dt>Where</dt>
                  <dd>{job.location ?? 'Not stated'}</dd>
                </div>
                <div>
                  <dt>Posted</dt>
                  <dd>{postedText(job)}</dd>
                </div>
                <div>
                  <dt>Pay</dt>
                  <dd>{job.pay?.text ?? 'Not listed'}</dd>
                </div>
                <div>
                  <dt>Direct line</dt>
                  <dd>{directTag(job).text}</dd>
                </div>
              </dl>
              <div className="tags">
                {flagTags(job).map((t) => (
                  <span key={t.text} className={`tg ${t.tone}`}>
                    {t.text}
                  </span>
                ))}
              </div>
              <RowActions job={job} onOpen={onOpen} onToggleAvailable={onToggleAvailable} />
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
            <SortHeader label="Posted" column="posted" sort={sort} onSort={onSort} />
            <SortHeader label="Company" column="company" sort={sort} onSort={onSort} />
            <SortHeader label="Role" column="role" sort={sort} onSort={onSort} />
            <SortHeader label="Where" column="where" sort={sort} onSort={onSort} />
            <SortHeader label="Pay" column="pay" sort={sort} onSort={onSort} />
            <SortHeader label="Direct line" column="direct" sort={sort} onSort={onSort} />
            <th scope="col">Flags</th>
            <th scope="col">Listing</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className={job.blocked || job.rule_blocked ? 'blk' : undefined}>
              <td data-label="Posted">{postedText(job)}</td>
              <td data-label="Company">{job.company ?? 'Company not stated'}</td>
              <td data-label="Role">
                <span className="role">{job.title}</span>
              </td>
              <td data-label="Where">
                {job.location ?? 'Not stated'}
                <p className="sub">{arrangementWord(job.arrangement)}</p>
              </td>
              <td data-label="Pay">{job.pay?.text ?? 'Not listed'}</td>
              <td data-label="Direct line">
                <span className={`tg${directTag(job).dir ? ' dir' : ''}`}>{directTag(job).text}</span>
              </td>
              <td data-label="Flags">
                {flagTags(job).map((t) => (
                  <span key={t.text} className={`tg ${t.tone}`}>
                    {t.text}
                  </span>
                ))}
              </td>
              <td data-label="Listing">
                <RowActions job={job} onOpen={onOpen} onToggleAvailable={onToggleAvailable} />
              </td>
            </tr>
          ))}
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

function RowActions(props: { job: JobListItem; onOpen: (job: JobListItem) => void; onToggleAvailable: (job: JobListItem) => void }) {
  const { job, onOpen, onToggleAvailable } = props;
  return (
    <div className="row-actions">
      <button type="button" className="btn" data-row-button onClick={() => onOpen(job)}>
        Open listing
      </button>
      {!(job.blocked || job.rule_blocked) && (
        <button type="button" className="btn btn-dark" data-row-button onClick={() => onToggleAvailable(job)}>
          {job.closed ? 'Reopen' : 'Not available'}
        </button>
      )}
    </div>
  );
}
