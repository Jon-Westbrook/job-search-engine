import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { shortDate } from '../format.ts';

const STATUSES = ['saved', 'applied', 'interviewing', 'rejected', 'offer'] as const;
type Status = (typeof STATUSES)[number];

interface AppRow {
  id: number;
  company: string;
  title: string;
  source_url: string | null;
  status: Status;
  stage: string;
  applied_at: string | null;
  source_channel: string | null;
  notes: string | null;
  origin: 'manual' | 'import' | 'progress';
  import_status: 'ok' | 'uncertain' | null;
}

interface PlanRow {
  source: string;
  company: string;
  title: string;
  applied_at: string | null;
  status: Status;
  raw_status: string | null;
  uncertain: boolean;
  reasons: string[];
}

interface PlanResponse {
  available: boolean;
  message?: string;
  generated_at?: string;
  applications_in_log?: number;
  counts?: { ok: number; uncertain: number; skipped_non_application: number };
  rows?: PlanRow[];
}

export function Tracker(props: { onNotice: (m: string) => void }) {
  const [rows, setRows] = useState<AppRow[]>([]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | Status>('');
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [form, setForm] = useState({ company: '', title: '', source_url: '', status: 'saved' as Status, applied_at: '', notes: '' });

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (status) params.set('status', status);
      const data = await api.get<{ items: AppRow[] }>(`applications?${params}`);
      setRows(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The Tracker did not load.');
    }
  }, [q, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadPlan = async () => {
    try {
      setPlan(await api.get<PlanResponse>('tracker/import/plan'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import plan did not load.');
    }
  };

  const changeStatus = async (id: number, next: Status, note: string) => {
    try {
      await api.patch(`applications/${id}`, { status: next, note: note.trim() || null });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The status did not change.');
    }
  };

  const add = async () => {
    try {
      await api.post('applications', {
        company: form.company,
        title: form.title,
        source_url: form.source_url.trim() || null,
        status: form.status,
        applied_at: form.applied_at.trim() || null,
        notes: form.notes.trim() || null,
      });
      setForm({ company: '', title: '', source_url: '', status: 'saved', applied_at: '', notes: '' });
      props.onNotice('Application added.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The application did not save.');
    }
  };

  const runImport = async () => {
    try {
      const out = await api.post<{ inserted: number; skipped_already_imported: number; uncertain: number }>('tracker/import', { confirm: true });
      props.onNotice(`Imported ${out.inserted} applications. ${out.uncertain} are marked uncertain.`);
      setPlan(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The import did not run.');
    }
  };

  return (
    <section className="tracker" aria-labelledby="tracker-title">
      <div className="hd">
        <h1 id="tracker-title" className="title">
          Tracker
        </h1>
      </div>

      <div className="filters">
        <label className="field-grow">
          <span className="field-label">Search by company or title</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          <span className="field-label">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as '' | Status)}>
            <option value="">All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className="tracker-body">
        <div className="list-wrap">
          {rows.length === 0 ? (
            <p className="empty">No applications match. Add one below, or import from the job-search log.</p>
          ) : (
            <ul className="app-list">
              {rows.map((r) => (
                <li key={r.id} className="app-row">
                  <div className="app-main">
                    <p className="role">{r.title}</p>
                    <p className="sub">
                      {r.company}
                      {r.applied_at ? ` / applied ${shortDate(r.applied_at)}` : ' / date not recorded'}
                    </p>
                    <div className="tags">
                      <span className="tg">{r.origin === 'import' ? 'Imported' : r.origin === 'progress' ? 'From Inbox' : 'Added by hand'}</span>
                      {r.status === 'saved' && <span className="tg">In Analysis, not applied</span>}
                      {r.import_status === 'uncertain' && <span className="tg yel">Uncertain, needs review</span>}
                      {r.source_channel && <span className="tg">{r.source_channel}</span>}
                    </div>
                    {r.notes && <p className="note">{r.notes}</p>}
                  </div>
                  <StatusControl row={r} onChange={changeStatus} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside className="panel tracker-side" aria-label="Add and import">
          <div className="sec">
            <h3>Add an application</h3>
            <label className="stack">
              <span className="field-label">Company</span>
              <input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
            </label>
            <label className="stack">
              <span className="field-label">Role title</span>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </label>
            <label className="stack">
              <span className="field-label">Listing link (optional)</span>
              <input value={form.source_url} onChange={(e) => setForm({ ...form, source_url: e.target.value })} />
            </label>
            <label className="stack">
              <span className="field-label">Status</span>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Status })}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack">
              <span className="field-label">Applied on (YYYY-MM-DD, optional)</span>
              <input value={form.applied_at} onChange={(e) => setForm({ ...form, applied_at: e.target.value })} />
            </label>
            <label className="stack">
              <span className="field-label">Notes</span>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <button type="button" className="btn" onClick={add} disabled={!form.company.trim() || !form.title.trim()}>
              Add application
            </button>
          </div>

          <div className="sec">
            <h3>Import from the job-search log</h3>
            <p className="note">The log is read, never written. A snapshot made on your own machine is used here.</p>
            {!plan && (
              <button type="button" className="btn btn-dark" onClick={loadPlan}>
                Review the import plan
              </button>
            )}
            {plan && !plan.available && <p>{plan.message}</p>}
            {plan?.available && plan.counts && (
              <div className="stack">
                <p>
                  {plan.applications_in_log} applications in the log. {plan.counts.ok} clear, {plan.counts.uncertain} need review.
                  {' '}{plan.counts.skipped_non_application} other entries are not tracker records.
                </p>
                <ul className="plan-list">
                  {(plan.rows ?? []).filter((r) => r.uncertain).map((r) => (
                    <li key={r.source}>
                      <strong>{r.company}</strong>, {r.title}: {r.reasons.join('; ')}
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn" onClick={runImport}>
                  Import {plan.applications_in_log} applications
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

function StatusControl(props: { row: AppRow; onChange: (id: number, s: Status, note: string) => void }) {
  const { row, onChange } = props;
  const [next, setNext] = useState<Status>(row.status);
  const [note, setNote] = useState('');
  return (
    <div className="status-control">
      <label>
        <span className="field-label">Status</span>
        <select value={next} onChange={(e) => setNext(e.target.value as Status)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <input aria-label="Note for this status change (optional)" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button type="button" className="btn btn-dark" onClick={() => onChange(row.id, next, note)} disabled={next === row.status}>
        Save status
      </button>
    </div>
  );
}
