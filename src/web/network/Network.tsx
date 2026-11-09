import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { NetworkContact, NetworkJob, NetworkRow, OutreachRecord } from '../../shared/types.ts';
import { draftMessage, type OwnerMessage } from '../../shared/drafts.ts';
import { linkedInPlace } from '../../shared/person.ts';
import { postedText, shortDate } from '../format.ts';
import { useSmallScreen } from '../hooks.ts';
import { RowActions, type Decide } from '../inbox/RowActions.tsx';
import { DONE, openListing, sendDecision } from '../inbox/useJobDecisions.ts';

// Everyone you know, grouped by company, with the open jobs there ranked by score. Pick a person from
// the list and a role, and the draft is always open. Copy and open LinkedIn, then mark it sent. You
// send it yourself; the app never sends a message.

const RELATIONSHIP: Record<string, string> = {
  friend: 'Friend',
  referral: 'Referral',
  'former employer': 'Former employer',
  recruiter: 'Recruiter',
  'former colleague': 'Former colleague',
  alumni: 'Alumni',
  connection: 'Connection',
};

interface Props {
  onNotice: (message: string) => void;
}

// What the draft for a company currently says: who it goes to, which role, and any text you edited.
interface Pick {
  personIndex: number;
  jobId: number | null;
  text?: string;
}

export function Network({ onNotice }: Props) {
  const small = useSmallScreen();
  const [rows, setRows] = useState<NetworkRow[] | null>(null);
  const [me, setMe] = useState<OwnerMessage>({});
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, Pick>>({});

  function load() {
    return api
      .get<{ rows: NetworkRow[]; me: OwnerMessage }>('network')
      .then((data) => {
        setRows(data.rows);
        setMe(data.me);
      })
      .catch(() => setError('The network did not load. Check that the server is running.'));
  }

  useEffect(() => {
    void load();
  }, []);

  // The line leaves the list at once. The company's next job fills the gap when the list reloads.
  async function decide(job: NetworkJob, action: Decide) {
    setRows((rs) => rs && rs.map((r) => (r.jobs.some((j) => j.id === job.id) ? { ...r, jobs: r.jobs.filter((j) => j.id !== job.id), job_count: Math.max(0, r.job_count - 1) } : r)));
    try {
      const out = await sendDecision([job.id], action);
      onNotice(out.done ? `${job.title} ${DONE[action]}.` : 'That job could not change.');
    } catch (err) {
      onNotice(err instanceof ApiError ? err.message : 'The job did not update.');
    }
    void load();
  }

  // The first person and the first job are the default, so the draft is open straight away.
  function pickFor(row: NetworkRow): Pick {
    return picks[row.company] ?? { personIndex: 0, jobId: row.jobs[0]?.id ?? null };
  }

  function choose(row: NetworkRow, next: Pick) {
    setPicks((p) => ({ ...p, [row.company]: next }));
  }

  async function copy(text: string, then?: () => void) {
    try {
      await navigator.clipboard.writeText(text);
      onNotice(then ? 'Draft copied. On LinkedIn, click Message and paste. Then press "I sent it".' : 'Draft copied. Paste it into LinkedIn and send it yourself.');
      then?.();
    } catch {
      onNotice('Could not copy. Select the text and copy it by hand.');
    }
  }

  async function markSent(person: NetworkContact, jobId: number | null) {
    try {
      await api.post('outreach', { person_key: person.key, job_id: jobId });
      onNotice(`Recorded. ${person.name} is due for a follow-up in 7 days.`);
      await load();
    } catch (err) {
      onNotice(err instanceof ApiError ? err.message : 'Could not record it.');
    }
  }

  if (error) return <section className="placeholder" aria-label="Network"><p className="empty">{error}</p></section>;
  if (rows === null) return <section className="placeholder" aria-label="Network"><p className="empty">Loading the network.</p></section>;

  return (
    <section className="network" aria-label="Network">
      <h1 className="title">Network</h1>
      {rows.length === 0 && <p className="empty">No contacts yet. Add them to config/contacts.local.json.</p>}
      <ul className="network-list">
        {rows.map((row) => {
          const pick = pickFor(row);
          const person = row.contacts[pick.personIndex] ?? null;
          const job = row.jobs.find((j) => j.id === pick.jobId) ?? null;
          const text = pick.text ?? (person ? messageFor(row, pick.personIndex, job, me) : '');
          const existing = person ? findRecord(row, person.key, pick.jobId) : undefined;
          return (
            <li key={row.company} className="network-row">
              <div className="network-company">
                <p className="role">
                  {row.company} {row.target && <span className="tg dir">Target</span>}
                </p>
                <p className="sub">
                  {row.contacts.length} {row.contacts.length === 1 ? 'person' : 'people'} / {row.job_count > 0 ? `${row.job_count} open ${row.job_count === 1 ? 'job' : 'jobs'}` : 'no open jobs'}
                </p>
                {row.contacts.map((c, i) => {
                  const last = lastRecord(row, c.key);
                  return (
                    <button key={c.key} type="button" className={`network-person${i === pick.personIndex ? ' sel' : ''}`} aria-pressed={i === pick.personIndex} onClick={() => choose(row, { personIndex: i, jobId: pick.jobId })}>
                      <span>{c.name}</span>
                      {c.position && <span className="sub">{c.position}</span>}
                      <span className="tg">{RELATIONSHIP[c.relationship] ?? c.relationship}</span>
                      {last && <span className="sub">Messaged {shortDate(last.sent_at)}</span>}
                    </button>
                  );
                })}
              </div>

              <ul className="network-jobs">
                {row.jobs.map((j) => (
                  <JobLine
                    key={j.id}
                    job={j}
                    records={row.outreach.filter((o) => o.job_id === j.id && o.status !== 'dropped')}
                    onOpen={() => openListing(j, small)}
                    onDecide={(action) => decide(j, action)}
                  />
                ))}
                {row.job_count > row.jobs.length && <li className="sub">and {row.job_count - row.jobs.length} more in the Inbox</li>}
              </ul>

              <div className="network-people">
                {person && (
                  <div className="network-draft">
                    <label className="field-label" htmlFor={`role-${row.company}`}>Role</label>
                    <select id={`role-${row.company}`} value={pick.jobId ?? ''} onChange={(e) => choose(row, { personIndex: pick.personIndex, jobId: e.target.value ? Number(e.target.value) : null })}>
                      {row.jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.title}
                        </option>
                      ))}
                      <option value="">No specific role</option>
                    </select>

                    {job && (
                      <a href={job.url} target="_blank" rel="noreferrer">
                        Open the listing to check it
                      </a>
                    )}

                    <textarea rows={7} value={text} onChange={(e) => choose(row, { ...pick, text: e.target.value })} aria-label="Draft message" />

                    <div className="network-draft-actions">
                      <button type="button" className="btn" onClick={() => copy(text, () => window.open(linkedInPlace(person.name, row.company, person.profile_url), '_blank', 'noopener'))}>
                        Copy and open LinkedIn
                      </button>
                      {existing ? <p className="sub">{statusLine(existing)}</p> : <button type="button" className="btn btn-dark" onClick={() => markSent(person, pick.jobId)}>I sent it</button>}
                    </div>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// The record for this person and role, if one exists and is not dropped.
function findRecord(row: NetworkRow, personKey: string, jobId: number | null): OutreachRecord | undefined {
  return row.outreach.find((o) => o.person_key === personKey && o.job_id === jobId && o.status !== 'dropped');
}

// The most recent message to this person, whatever the role.
function lastRecord(row: NetworkRow, personKey: string): OutreachRecord | undefined {
  return row.outreach.filter((o) => o.person_key === personKey && o.status !== 'dropped').sort((a, b) => b.sent_at.localeCompare(a.sent_at))[0];
}

function statusLine(record: OutreachRecord): string {
  if (record.status === 'replied') return `They replied.`;
  if (record.status === 'referred') return `They offered a referral.`;
  if (record.due) return `Asked ${shortDate(record.sent_at)}. Follow-up due. See the Follow-up tab.`;
  return `Asked ${shortDate(record.sent_at)}, waiting for a reply.`;
}

function messageFor(row: NetworkRow, personIndex: number, job: NetworkJob | null, me: OwnerMessage): string {
  const person = row.contacts[personIndex];
  return draftMessage(person?.name ?? '', row.company, job ? { title: job.title, url: job.url } : null, me);
}

// Open listing, Not available, and Applied. Applied stays visible but is disabled once the job has it.
function JobLine({ job, records, onOpen, onDecide }: { job: NetworkJob; records: OutreachRecord[]; onOpen: () => void; onDecide: (action: Decide) => void }) {
  return (
    <li>
      <span className="network-job-title">{job.title}</span>
      <span className="sub">
        {job.location ?? 'Location not stated'} / {postedText({ posted_at: job.posted_at, posted_estimated: job.posted_estimated })}
      </span>
      <span className="tg">{job.score === null ? 'not scored' : `score ${job.score}`}</span>
      <RowActions actions={['not_available', 'applied']} done={job.applied ? ['applied'] : []} count={0} onOpen={onOpen} onDecide={onDecide} />
      {records.map((r) => (
        <span key={r.id} className={`tg ${r.status === 'replied' || r.status === 'referred' ? 'dir' : r.due ? 'red' : 'yel'}`}>
          {r.status === 'replied' ? `${r.person_name} replied` : r.status === 'referred' ? `${r.person_name} referred` : r.due ? `Follow up ${r.person_name}` : `Asked ${r.person_name}`}
        </span>
      ))}
    </li>
  );
}
