import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { NetworkContact, NetworkJob, NetworkRow } from '../../shared/types.ts';
import { draftMessage } from '../../shared/drafts.ts';
import { postedText } from '../format.ts';

// Everyone you know, grouped by company, with the open jobs there ranked by score. For a company,
// pick the person and the role, and the draft includes the listing link. Copy it, or copy and open
// the person on LinkedIn. You send it yourself; the app never sends a message.

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
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState<Writing | null>(null);

  useEffect(() => {
    api
      .get<{ rows: NetworkRow[] }>('network')
      .then((data) => setRows(data.rows))
      .catch(() => setError('The network did not load. Check that the server is running.'));
  }, []);

  function start(row: NetworkRow) {
    if (writing?.company === row.company) return setWriting(null);
    const job = row.jobs[0] ?? null;
    setWriting({ company: row.company, personIndex: 0, jobId: job?.id ?? null, text: messageFor(row, 0, job) });
  }

  function change(row: NetworkRow, personIndex: number, jobId: number | null) {
    const job = row.jobs.find((j) => j.id === jobId) ?? null;
    setWriting({ company: row.company, personIndex, jobId, text: messageFor(row, personIndex, job) });
  }

  async function copy(text: string, then?: () => void) {
    try {
      await navigator.clipboard.writeText(text);
      onNotice(then ? 'Draft copied. On LinkedIn, click Message and paste.' : 'Draft copied. Paste it into LinkedIn and send it yourself.');
      then?.();
    } catch {
      onNotice('Could not copy. Select the text and copy it by hand.');
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
                  <JobLine key={j.id} job={j} />
                ))}
                {row.job_count > row.jobs.length && <li className="sub">and {row.job_count - row.jobs.length} more in the Inbox</li>}
              </ul>

              <div className="network-people">
                {row.contacts.map((c) => (
                  <div key={`${row.company}|${c.name}`} className="network-person">
                    <span>{c.name}</span>
                    {c.position && <span className="sub">{c.position}</span>}
                    <span className="tg">{RELATIONSHIP[c.relationship] ?? c.relationship}</span>
                  </div>
                ))}

                {open && person && (
                  <div className="network-draft">
                    <label className="field-label" htmlFor={`person-${row.company}`}>Person</label>
                    <select id={`person-${row.company}`} value={open.personIndex} onChange={(e) => change(row, Number(e.target.value), open.jobId)}>
                      {row.contacts.map((c, i) => (
                        <option key={c.name} value={i}>
                          {c.name}
                          {c.position ? ` / ${c.position}` : ''}
                        </option>
                      ))}
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

                    <textarea rows={6} value={open.text} onChange={(e) => setWriting({ ...open, text: e.target.value })} aria-label="Draft message" />

                    <div className="network-draft-actions">
                      <button type="button" className="btn" onClick={() => copy(open.text)}>
                        Copy draft
                      </button>
                      <button type="button" className="btn btn-dark" onClick={() => copy(open.text, () => window.open(linkedInPlace(person, row.company), '_blank', 'noopener'))}>
                        Copy and open LinkedIn
                      </button>
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

function messageFor(row: NetworkRow, personIndex: number, job: NetworkJob | null): string {
  const person = row.contacts[personIndex];
  return draftMessage(person?.name ?? '', row.company, job ? { title: job.title, url: job.url } : null);
}

function JobLine({ job }: { job: NetworkJob }) {
  return (
    <li>
      <a className="network-job-title" href={job.url} target="_blank" rel="noreferrer">
        {job.title}
      </a>
      <span className="sub">
        {job.location ?? 'Location not stated'} / {postedText({ posted_at: job.posted_at, posted_estimated: job.posted_estimated })}
      </span>
      <span className="tg">{job.score === null ? 'not scored' : `score ${job.score}`}</span>
    </li>
  );
}

// The person's profile when we have it. Otherwise a LinkedIn people search for name and company.
export function linkedInPlace(contact: NetworkContact, company: string): string {
  if (contact.profile_url) return contact.profile_url;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${contact.name} ${company}`)}`;
}
