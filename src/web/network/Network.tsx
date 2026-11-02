import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { NetworkRow } from '../../shared/types.ts';
import { draftMessage } from '../../shared/drafts.ts';
import { postedText } from '../format.ts';

// People you know, by company, with the open jobs there ranked by score. A draft is copied to
// the clipboard. The app never sends a message; you send it yourself on LinkedIn.

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
  contact: string;
  company: string;
  jobId: number | null;
}

export function Network({ onNotice }: Props) {
  const [rows, setRows] = useState<NetworkRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyWithJobs, setOnlyWithJobs] = useState(true);
  const [draft, setDraft] = useState<OpenDraft | null>(null);

  useEffect(() => {
    api
      .get<{ rows: NetworkRow[] }>('network')
      .then((data) => setRows(data.rows))
      .catch(() => setError('The network did not load. Check that the server is running.'));
  }, []);

  const shown = useMemo(() => (rows ?? []).filter((r) => !onlyWithJobs || r.job_count > 0), [rows, onlyWithJobs]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      onNotice('Draft copied. Paste it into LinkedIn and send it yourself.');
    } catch {
      onNotice('Could not copy. Select the text and copy it by hand.');
    }
  }

  if (error) return <section className="placeholder" aria-label="Network"><p className="empty">{error}</p></section>;
  if (rows === null) return <section className="placeholder" aria-label="Network"><p className="empty">Loading the network.</p></section>;

  return (
    <section className="network" aria-label="Network">
      <div className="network-head">
        <h1 className="title">Network</h1>
        <label className="network-toggle">
          <input type="checkbox" checked={onlyWithJobs} onChange={(e) => setOnlyWithJobs(e.target.checked)} /> Only companies with open jobs
        </label>
      </div>
      {shown.length === 0 && <p className="empty">{rows.length === 0 ? 'No contacts yet. Add them to config/contacts.local.json.' : 'No company with open jobs yet.'}</p>}
      <ul className="network-list">
        {shown.map((row) => (
          <li key={row.company} className="network-row">
            <div className="network-company">
              <p className="role">
                {row.company} {row.target && <span className="tg dir">Target</span>}
              </p>
              <p className="sub">
                {row.contacts.length} {row.contacts.length === 1 ? 'person' : 'people'} you know
                {row.job_count > 0 ? ` / ${row.job_count} open ${row.job_count === 1 ? 'job' : 'jobs'}` : ' / no open jobs'}
              </p>
            </div>

            <div className="network-people">
              {row.contacts.map((c) => {
                const key = `${row.company}|${c.name}`;
                const open = draft?.key === key;
                return (
                  <div key={key} className="network-person">
                    <span>
                      {c.name} <span className="tg">{RELATIONSHIP[c.relationship] ?? c.relationship}</span>
                    </span>
                    {row.job_count > 0 && (
                      <button
                        type="button"
                        className="btn"
                        aria-expanded={open}
                        onClick={() => setDraft(open ? null : { key, contact: c.name, company: row.company, jobId: row.jobs[0]?.id ?? null })}
                      >
                        {open ? 'Close draft' : 'Draft message'}
                      </button>
                    )}
                    {open && draft && (
                      <DraftBox
                        draft={draft}
                        jobs={row.jobs}
                        onChange={setDraft}
                        onCopy={copy}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {row.jobs.length > 0 && (
              <ul className="network-jobs">
                {row.jobs.map((j) => (
                  <li key={j.id}>
                    <span className="network-job-title">{j.title}</span>
                    <span className="sub">
                      {j.location ?? 'Location not stated'} / {postedText({ posted_at: j.posted_at, posted_estimated: j.posted_estimated })}
                    </span>
                    <span className="tg">{j.score === null ? 'not scored' : `score ${j.score}`}</span>
                  </li>
                ))}
                {row.job_count > row.jobs.length && <li className="sub">and {row.job_count - row.jobs.length} more in the Inbox</li>}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function DraftBox({
  draft,
  jobs,
  onChange,
  onCopy,
}: {
  draft: OpenDraft;
  jobs: NetworkRow['jobs'];
  onChange: (d: OpenDraft) => void;
  onCopy: (text: string) => void;
}) {
  const job = jobs.find((j) => j.id === draft.jobId) ?? null;
  const text = draftMessage(draft.contact, draft.company, job?.title ?? null);
  return (
    <div className="network-draft">
      <label className="field-label" htmlFor={`draft-job-${draft.key}`}>Role to mention</label>
      <select id={`draft-job-${draft.key}`} value={draft.jobId ?? ''} onChange={(e) => onChange({ ...draft, jobId: e.target.value ? Number(e.target.value) : null })}>
        {jobs.map((j) => (
          <option key={j.id} value={j.id}>
            {j.title}
          </option>
        ))}
        <option value="">No specific role</option>
      </select>
      <textarea readOnly rows={5} value={text} aria-label="Draft message" />
      <button type="button" className="btn" onClick={() => onCopy(text)}>
        Copy draft
      </button>
    </div>
  );
}
