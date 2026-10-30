import { useRef, type KeyboardEvent } from 'react';
import type { JobListItem } from '../../shared/types.ts';
import { arrangementWord, postedLabel, scoreAnnouncement } from '../format.ts';

// Desktop: a real table with scope headers. Phone: cards with the same fields in the same order.
export function flagTags(job: JobListItem): Array<{ text: string; tone: string }> {
  const tags: Array<{ text: string; tone: string }> = [];
  if (job.rule_blocked) tags.push({ text: 'Blocked by rule', tone: 'red' });
  else if (job.blocked) tags.push({ text: 'Blocked', tone: 'red' });
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
  selectedId: number | null;
  onSelect: (id: number) => void;
  onVerdict: (id: number, verdict: 'good' | 'maybe' | 'bad') => void;
  onQuickProgress: (id: number) => void;
  small: boolean;
  emptyText: string;
  collapsing: number | null;
}

export function JobList(props: ListProps) {
  const { jobs, selectedId, onSelect, small, emptyText, collapsing } = props;
  const tableRef = useRef<HTMLTableElement>(null);

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
      <div className="cards" onKeyDown={moveFocus}>
        {jobs.map((job) => (
          <article key={job.id} className={`card${selectedId === job.id ? ' sel' : ''}${job.blocked || job.rule_blocked ? ' blk' : ''}${collapsing === job.id ? ' collapsing' : ''}`}>
            <div className="card-top">
              <div className={`score${job.blocked || job.rule_blocked ? ' blk' : ''}`} aria-label={scoreAnnouncement(job.score, job.confidence)}>
                {job.score ?? '-'}
              </div>
              <div>
                <button type="button" className="role-btn" data-row-button onClick={() => onSelect(job.id)}>
                  <span className="role">{job.title}</span>
                </button>
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
                <dd>{postedLabel(job.posted_at)}</dd>
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
            <VerdictRow job={job} onVerdict={props.onVerdict} />
            <button type="button" className="act" onClick={() => props.onQuickProgress(job.id)} disabled={Boolean(job.blocked || job.rule_blocked)}>
              {job.applied || job.in_analysis ? 'Progress (reason needed)' : 'Progress this job'}
            </button>
          </article>
        ))}
      </div>
    );
  }

  return (
    <div className="list">
      <table ref={tableRef} onKeyDown={moveFocus}>
        <thead>
          <tr>
            <th scope="col">Score</th>
            <th scope="col">Role</th>
            <th scope="col">Where</th>
            <th scope="col">Posted</th>
            <th scope="col">Pay</th>
            <th scope="col">Direct line</th>
            <th scope="col">Flags</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => {
            const blocked = Boolean(job.blocked || job.rule_blocked);
            return (
              <tr key={job.id} className={`${selectedId === job.id ? 'sel' : ''}${blocked ? ' blk' : ''}${collapsing === job.id ? ' collapsing' : ''}`} onClick={() => onSelect(job.id)}>
                <td data-label="Score" aria-label={scoreAnnouncement(job.score, job.confidence)}>
                  <span className={`sc${blocked ? ' blk' : ''}`}>{job.score ?? '-'}</span>
                </td>
                <td data-label="Role">
                  <button type="button" className="role-btn" data-row-button onClick={(e) => { e.stopPropagation(); onSelect(job.id); }}>
                    <span className="role">{job.title}</span>
                  </button>
                  <p className="sub">{job.company ?? 'Company not stated'}</p>
                </td>
                <td data-label="Where">
                  {job.location ?? 'Not stated'}
                  <p className="sub">{arrangementWord(job.arrangement)}</p>
                </td>
                <td data-label="Posted">{postedLabel(job.posted_at)}</td>
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
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function VerdictRow(props: { job: JobListItem; onVerdict: (id: number, v: 'good' | 'maybe' | 'bad') => void }) {
  const { job, onVerdict } = props;
  return (
    <div className="fb" role="group" aria-label={`Verdict for ${job.title}`}>
      {(['good', 'maybe', 'bad'] as const).map((v) => (
        <button key={v} type="button" aria-pressed={job.verdict === v} onClick={() => onVerdict(job.id, v)}>
          {v === 'good' ? 'Good' : v === 'maybe' ? 'Maybe' : 'Bad'}
        </button>
      ))}
    </div>
  );
}
