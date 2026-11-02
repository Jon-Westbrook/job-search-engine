import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import type { NetworkContact, NetworkJob, NetworkRow } from '../../shared/types.ts';
import { draftMessage } from '../../shared/drafts.ts';
import { postedText } from '../format.ts';

// Everyone you know, grouped by company, with the open jobs there ranked by score. A draft is
// written for you to edit. Copy it, or copy and open the person on LinkedIn; you send it yourself.

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

interface OpenDraft {
  key: string;
  contact: NetworkContact;
  company: string;
  jobId: number | null;
  text: string;
}

export function Network({ onNotice }: Props) {
  const [rows, setRows] = useState<NetworkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<OpenDraft | null>(null);

  useEffect(() => {
    api
      .get<{ rows: NetworkRow[] }>('network')
      .then((data) => setRows(data.rows))
      .catch(() => setError('The network did not load. Check that the server is running.'));
  }, []);

  function openDraft(row: NetworkRow, contact: NetworkContact) {
    const key = `${row.company}|${contact.name}`;
    if (draft?.key === key) return setDraft(null);
    const jobId = row.jobs[0]?.id ?? null;
    const job = row.jobs[0] ?? null;
    setDraft({ key, contact, company: row.company, jobId, text: draftMessage(contact.name, row.company, job?.title ?? null) });
  }

  function pickJob(row: NetworkRow, jobId: number | null) {
    if (!draft) return;
    const job = row.jobs.find((j) => j.id === jobId) ?? null;
    setDraft({ ...draft, jobId, text: draftMessage(draft.contact.name, row.company, job?.title ?? null) });
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
        {rows.map((row) => (
          <li key={row.company} className="network-row">
            <div className="network-company">
              <p className="role">
                {row.company} {row.target && <span className="tg dir">Target</span>}
              </p>
              <p className="sub">
                {row.contacts.length} {row.contacts.length === 1 ? 'person' : 'people'} / {row.job_count > 0 ? `${row.job_count} open ${row.job_count === 1 ? 'job' : 'jobs'}` : 'no open jobs'}
              </p>
            </div>

            <ul className="network-jobs">
              {row.jobs.map((j) => (
                <JobLine key={j.id} job={j} />
              ))}
              {row.job_count > row.jobs.length && <li className="sub">and {row.job_count - row.jobs.length} more in the Inbox</li>}
            </ul>

            <div className="network-people">
              {row.contacts.map((c) => {
                const key = `${row.company}|${c.name}`;
                const open = draft?.key === key;
                return (
                  <div key={key} className="network-person">
                    <span>
                      {c.name} <span className="tg">{RELATIONSHIP[c.relationship] ?? c.relationship}</span>
                    </span>
                    <button type="button" className="btn" aria-expanded={open} onClick={() => openDraft(row, c)}>
                      {open ? 'Close' : 'Draft message'}
                    </button>
                    {open && draft && (
                      <DraftBox
                        draft={draft}
                        row={row}
                        onPickJob={(id) => pickJob(row, id)}
                        onEdit={(text) => setDraft({ ...draft, text })}
                        onCopy={() => copy(draft.text)}
                        onOpen={() => copy(draft.text, () => window.open(linkedInPlace(draft.contact, row.company), '_blank', 'noopener'))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
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

function DraftBox({
  draft,
  row,
  onPickJob,
  onEdit,
  onCopy,
  onOpen,
}: {
  draft: OpenDraft;
  row: NetworkRow;
  onPickJob: (id: number | null) => void;
  onEdit: (text: string) => void;
  onCopy: () => void;
  onOpen: () => void;
}) {
  const job = row.jobs.find((j) => j.id === draft.jobId) ?? null;
  return (
    <div className="network-draft">
      <label className="field-label" htmlFor={`draft-job-${draft.key}`}>Role to mention</label>
      <select id={`draft-job-${draft.key}`} value={draft.jobId ?? ''} onChange={(e) => onPickJob(e.target.value ? Number(e.target.value) : null)}>
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
      <textarea rows={5} value={draft.text} onChange={(e) => onEdit(e.target.value)} aria-label="Draft message" />
      <div className="network-draft-actions">
        <button type="button" className="btn" onClick={onCopy}>
          Copy draft
        </button>
        <button type="button" className="btn btn-dark" onClick={onOpen}>
          Copy and open LinkedIn
        </button>
      </div>
    </div>
  );
}
