import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { NetworkContact, NetworkJob, NetworkRow, OutreachRecord } from '../../shared/types.ts';
import { draftMessage, type OwnerMessage } from '../../shared/drafts.ts';
import { linkedInPlace } from '../../shared/person.ts';
import { postedText, shortDate } from '../format.ts';

// Everyone you know, grouped by company, with the open jobs there ranked by score. For a company,
// pick the person and the role, and the draft includes the listing link. Copy it, or copy and open
// the person on LinkedIn, then mark it sent. You send it yourself; the app never sends a message.

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

interface Writing {
  company: string;
  personIndex: number;
  jobId: number | null;
  text: string;
}

export function Network({ onNotice }: Props) {
  const [rows, setRows] = useState<NetworkRow[] | null>(null);
  const [me, setMe] = useState<OwnerMessage>({});
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState<Writing | null>(null);

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

  function start(row: NetworkRow) {
    if (writing?.company === row.company) return setWriting(null);
    const job = row.jobs[0] ?? null;
    setWriting({ company: row.company, personIndex: 0, jobId: job?.id ?? null, text: messageFor(row, 0, job, me) });
  }

  function change(row: NetworkRow, personIndex: number, jobId: number | null) {
    const job = row.jobs.find((j) => j.id === jobId) ?? null;
    setWriting({ company: row.company, personIndex, jobId, text: messageFor(row, personIndex, job, me) });
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
          const open = writing?.company === row.company ? writing : null;
          const person = open ? row.contacts[open.personIndex] ?? null : null;
          const existing = open && person ? findRecord(row, person.key, open.jobId) : null;
          return (
            <li key={row.company} className="network-row">
              <div className="network-company">
                <p className="role">
                  {row.company} {row.target && <span className="tg dir">Target</span>}
                </p>
                <p className="sub">
                  {row.contacts.length} {row.contacts.length === 1 ? 'person' : 'people'} / {row.job_count > 0 ? `${row.job_count} open ${row.job_count === 1 ? 'job' : 'jobs'}` : 'no open jobs'}
                </p>
                {row.job_count > 0 && (
                  <button type="button" className="btn" aria-expanded={!!open} onClick={() => start(row)}>
                    {open ? 'Close' : 'Write message'}
                  </button>
                )}
              </div>

              <ul className="network-jobs">
                {row.jobs.map((j) => (
                  <JobLine key={j.id} job={j} records={row.outreach.filter((o) => o.job_id === j.id && o.status !== 'dropped')} />
                ))}
                {row.job_count > row.jobs.length && <li className="sub">and {row.job_count - row.jobs.length} more in the Inbox</li>}
              </ul>

              <div className="network-people">
                {row.contacts.map((c) => {
                  const last = lastRecord(row, c.key);
                  return (
                    <div key={c.key} className="network-person">
                      <span>{c.name}</span>
                      {c.position && <span className="sub">{c.position}</span>}
                      <span className="tg">{RELATIONSHIP[c.relationship] ?? c.relationship}</span>
                      {last && <span className="sub">Messaged {shortDate(last.sent_at)}</span>}
                    </div>
                  );
                })}

                {open && person && (
                  <div className="network-draft">
                    <label className="field-label" htmlFor={`person-${row.company}`}>Person</label>
                    <select id={`person-${row.company}`} value={open.personIndex} onChange={(e) => change(row, Number(e.target.value), open.jobId)}>
                      {row.contacts.map((c, i) => {
                        const last = lastRecord(row, c.key);
                        return (
                          <option key={c.key} value={i}>
                            {c.name}
                            {c.position ? ` / ${c.position}` : ''}
                            {last ? ` / messaged ${shortDate(last.sent_at)}` : ''}
                          </option>
                        );
                      })}
                    </select>

                    <label className="field-label" htmlFor={`role-${row.company}`}>Role</label>
                    <select id={`role-${row.company}`} value={open.jobId ?? ''} onChange={(e) => change(row, open.personIndex, e.target.value ? Number(e.target.value) : null)}>
                      {row.jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.title}
                        </option>
                      ))}
                      <option value="">No specific role</option>
                    </select>

                    {open.jobId !== null && (
                      <a href={row.jobs.find((j) => j.id === open.jobId)?.url} target="_blank" rel="noreferrer">
                        Open the listing to check it
                      </a>
                    )}

                    <textarea rows={7} value={open.text} onChange={(e) => setWriting({ ...open, text: e.target.value })} aria-label="Draft message" />

                    <div className="network-draft-actions">
                      <button type="button" className="btn" onClick={() => copy(open.text)}>
                        Copy draft
                      </button>
                      <button type="button" className="btn btn-dark" onClick={() => copy(open.text, () => window.open(linkedInPlace(person.name, row.company, person.profile_url), '_blank', 'noopener'))}>
                        Copy and open LinkedIn
                      </button>
                    </div>

                    {existing ? (
                      <p className="sub">{statusLine(existing)}</p>
                    ) : (
                      <button type="button" className="btn" onClick={() => markSent(person, open.jobId)}>
                        I sent it
                      </button>
                    )}
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

function JobLine({ job, records }: { job: NetworkJob; records: OutreachRecord[] }) {
  return (
    <li>
      <a className="network-job-title" href={job.url} target="_blank" rel="noreferrer">
        {job.title}
      </a>
      <span className="sub">
        {job.location ?? 'Location not stated'} / {postedText({ posted_at: job.posted_at, posted_estimated: job.posted_estimated })}
      </span>
      <span className="tg">{job.score === null ? 'not scored' : `score ${job.score}`}</span>
      {records.map((r) => (
        <span key={r.id} className={`tg ${r.status === 'replied' || r.status === 'referred' ? 'dir' : r.due ? 'red' : 'yel'}`}>
          {r.status === 'replied' ? `${r.person_name} replied` : r.status === 'referred' ? `${r.person_name} referred` : r.due ? `Follow up ${r.person_name}` : `Asked ${r.person_name}`}
        </span>
      ))}
    </li>
  );
}
