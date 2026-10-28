import { useCallback, useEffect, useState, type RefObject } from 'react';
import { api, ApiError } from '../api.ts';
import type { JobDetail, Verdict } from '../../shared/types.ts';
import { REASON_TAGS } from '../../shared/types.ts';
import { arrangementWord, confidenceWord, scoreAnnouncement } from '../format.ts';
import { directTag } from './JobList.tsx';

const BLOCK_REASONS = ['Not interested', 'Wrong location', 'Wrong pay', 'Already applied elsewhere', 'Other'] as const;

export interface DetailProps {
  jobId: number;
  onChanged: () => void;
  onBlocked: (jobId: number) => void;
  onNotice: (message: string) => void;
  onClose: () => void;
  headingRef?: RefObject<HTMLHeadingElement | null>;
}

export function Detail(props: DetailProps) {
  const { jobId, onChanged, onBlocked, onNotice, onClose, headingRef } = props;
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progressLabel, setProgressLabel] = useState('Progress this job');
  const [needReason, setNeedReason] = useState<string | null>(null);
  const [reasonValue, setReasonValue] = useState('');
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockChoice, setBlockChoice] = useState<string>(BLOCK_REASONS[0]);
  const [blockOther, setBlockOther] = useState('');
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.get<JobDetail>(`jobs/${jobId}`);
      setJob(data);
      setTags(data.reason_tags ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The job could not be loaded.');
    }
  }, [jobId]);

  useEffect(() => {
    setJob(null);
    setNeedReason(null);
    setBlockOpen(false);
    setOverrideOpen(false);
    setPasteOpen(false);
    void load();
  }, [load]);

  // Runs an action, shows any error in the panel, and refreshes the list and the detail.
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      if (done) onNotice(done);
      onChanged();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const verdict = (v: Verdict) =>
    run(() => api.post(`jobs/${jobId}/verdict`, { verdict: v, reason_tags: [], note: null }));

  const saveReasons = () =>
    run(() => api.post(`jobs/${jobId}/verdict`, { verdict: job?.verdict ?? 'maybe', reason_tags: tags, note: note.trim() || null }), 'Reasons saved');

  const toggleTag = (t: string) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  const progress = async (reason: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`jobs/${jobId}/progress`, { reason });
      setNeedReason(null);
      setReasonValue('');
      setProgressLabel('Saved to Analysis');
      window.setTimeout(() => setProgressLabel('Progress this job'), 1500);
      onChanged();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.body as { error?: string })?.error === 'already_applied') {
        setNeedReason('This job already has an application. Enter a reason to continue.');
      } else {
        setError(err instanceof ApiError ? err.message : 'Progress did not save.');
      }
    } finally {
      setBusy(false);
    }
  };

  const openListing = async () => {
    try {
      const out = await api.post<{ url: string }>(`jobs/${jobId}/listing-opened`);
      window.open(out.url, '_blank', 'noopener,noreferrer');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The listing could not be opened.');
    }
  };

  const block = async () => {
    const reason = blockChoice === 'Other' ? blockOther.trim() : blockChoice;
    if (!reason) {
      setError('Add a reason for the block.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`jobs/${jobId}/block`, { reason });
      setBlockOpen(false);
      onBlocked(jobId);
      onChanged();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The block did not save.');
    } finally {
      setBusy(false);
    }
  };

  const override = () =>
    run(async () => {
      await api.post(`jobs/${jobId}/override`, { reason: reasonValue.trim() });
      setOverrideOpen(false);
      setReasonValue('');
    }, 'Block cleared. The job is back in its band.');

  const savePaste = () =>
    run(async () => {
      await api.post(`jobs/${jobId}/description`, { text: pasteText });
      setPasteOpen(false);
      setPasteText('');
    }, 'Description saved and scored again.');

  if (error && !job) return <p className="alert" role="alert">{error}</p>;
  if (!job) return <p className="muted">Loading the job</p>;

  const blocked = Boolean(job.blocked || job.rule_blocked);
  const sourceNames = job.sources.length > 1 ? `${job.sources.length} sources` : 'LinkedIn alert';
  const tier = directTag(job);

  return (
    <div className="detail-body">
      <span className="tagbox">Selected</span>
      <div>
        <h2 ref={headingRef} tabIndex={-1}>
          {job.title}
        </h2>
        <p className="co">
          {job.company ?? 'Company not stated'} / {sourceNames}
          {job.arrangement ? ` / ${arrangementWord(job.arrangement)}` : ''}
        </p>
      </div>

      <div className="big" aria-label={scoreAnnouncement(job.score, job.confidence)}>
        <b className={blocked ? 'blk' : ''}>{job.score ?? '-'}</b>
        <span>
          of 100
          <br />
          {confidenceWord(job.confidence)}
        </span>
      </div>

      {job.rule_blocked && (
        <div className="notice notice-red" role="status">
          <strong>Blocked by rule.</strong> The score is capped at 5.
          <ul className="ev">
            {job.rule_block_evidence.map((e, i) => (
              <li key={i}>
                Quoted from the {e.field}: &ldquo;{e.quote}&rdquo;
              </li>
            ))}
          </ul>
        </div>
      )}
      {job.blocked && (
        <div className="notice notice-red" role="status">
          <strong>Blocked.</strong> {job.blocked.reason}
        </div>
      )}
      {job.applied && (
        <div className="notice notice-clay" role="status">
          <strong>Already applied</strong>
          {job.applied.date ? ` ${job.applied.date}` : ''}. Matched on {job.applied.reason}. Progress needs a reason.
        </div>
      )}
      {job.possible_duplicate && (
        <div className="notice notice-clay" role="status">
          <strong>Possible duplicate.</strong> A listing with the same company and a similar title is kept separate until you group them.
        </div>
      )}

      {job.confidence === 'low' && (
        <div className="sec">
          <h3>Missing</h3>
          <p>{job.missing.length ? job.missing.join(', ') : 'Nothing else is missing.'}</p>
          {!pasteOpen ? (
            <button type="button" className="btn btn-dark" onClick={() => setPasteOpen(true)}>
              Paste description
            </button>
          ) : (
            <div className="stack">
              <label className="field-label" htmlFor="paste-desc">
                Paste the full description
              </label>
              <textarea id="paste-desc" rows={6} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
              <div className="row-actions">
                <button type="button" className="btn" onClick={savePaste} disabled={busy || pasteText.trim().length < 40}>
                  Save and score again
                </button>
                <button type="button" className="btn btn-dark" onClick={() => setPasteOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="sec">
        <h3>Score breakdown</h3>
        {job.factors.length === 0 && <p className="muted">No factor values yet.</p>}
        {job.factors.map((f) => (
          <div className="fac" key={f.factor}>
            <span>
              {f.factor}
              {f.ai_value && f.factor === 'TN and visa fit' ? ` (${f.ai_value})` : ''}
            </span>
            <span className="bar" aria-hidden="true">
              <i style={{ width: `${f.max ? Math.min(100, (f.points / f.max) * 100) : 0}%` }} />
            </span>
            <span className="fv">
              {Math.round(f.points * 10) / 10}/{f.max}
            </span>
          </div>
        ))}
        {job.penalties.map((p) => (
          <p key={p.factor} className="penalty">
            Penalty: {p.factor} ({p.points})
          </p>
        ))}
      </div>

      {job.direct_tier > 0 && (
        <div className="dl">
          <b>{tier.text}</b>
          <p>
            {job.direct_tier === 3
              ? 'The alert shows an unnamed signal, such as a connection count. No contact is created from it.'
              : 'A named contact connects you to this company. Points come from the contacts you entered.'}
          </p>
        </div>
      )}

      <div className="sec">
        <h3>Evidence</h3>
        <ul className="ev">
          {job.factors
            .filter((f) => f.evidence_excerpt)
            .map((f) => (
              <li key={`${f.factor}-ev`}>
                {f.factor}: &ldquo;{f.evidence_excerpt}&rdquo;
              </li>
            ))}
          {job.factors.every((f) => !f.evidence_excerpt) && <li>No quoted evidence for this score yet.</li>}
        </ul>
        <p className="note">TN fit is a screening aid, not a legal conclusion.</p>
      </div>

      <div className="sec">
        <h3>Your verdict</h3>
        <div className="fb" role="group" aria-label="Verdict">
          {(['good', 'maybe', 'bad'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={job.verdict === v} onClick={() => verdict(v)} disabled={busy}>
              {v === 'good' ? 'Good' : v === 'maybe' ? 'Maybe' : 'Bad'}
            </button>
          ))}
        </div>
        {job.verdict && (
          <div className="stack">
            <p className="field-label">Why? Pick any that apply.</p>
            <div className="chips" role="group" aria-label="Reason tags">
              {REASON_TAGS.map((t) => (
                <button key={t} type="button" aria-pressed={tags.includes(t)} onClick={() => toggleTag(t)}>
                  {t}
                </button>
              ))}
            </div>
            <label className="field-label" htmlFor="verdict-note">
              Note (optional, 500 characters)
            </label>
            <textarea id="verdict-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn btn-dark" onClick={saveReasons} disabled={busy}>
              Save reasons
            </button>
          </div>
        )}
        <p className="note">Verdicts are labels. They never change a score or a weight.</p>
      </div>

      {needReason && (
        <div className="stack notice notice-clay" role="group" aria-label="Reason to continue">
          <p>{needReason}</p>
          <label className="field-label" htmlFor="progress-reason">
            Reason
          </label>
          <input id="progress-reason" value={reasonValue} onChange={(e) => setReasonValue(e.target.value)} />
          <button type="button" className="btn" onClick={() => progress(reasonValue.trim())} disabled={busy || !reasonValue.trim()}>
            Continue with this reason
          </button>
        </div>
      )}

      <div className="sec">
        <button
          type="button"
          className="btn btn-dark wide"
          onClick={() => progress(null)}
          disabled={busy || blocked}
          aria-disabled={blocked}
        >
          {progressLabel}
        </button>
        <p className="note">Creates a saved application and moves it to Analysis.</p>
      </div>

      <div className="lnk">
        <button type="button" className="linkish" onClick={openListing} disabled={busy}>
          Open listing
        </button>
        {job.blocked || job.rule_blocked ? (
          <button type="button" className="linkish" onClick={() => setOverrideOpen((v) => !v)} disabled={busy}>
            Override and review
          </button>
        ) : (
          <button type="button" className="linkish brick" onClick={() => setBlockOpen((v) => !v)} disabled={busy} aria-expanded={blockOpen}>
            Block job
          </button>
        )}
      </div>

      {blockOpen && (
        <div className="stack">
          <label className="field-label" htmlFor="block-reason">
            Reason for this block (this job only)
          </label>
          <select id="block-reason" value={blockChoice} onChange={(e) => setBlockChoice(e.target.value)}>
            {BLOCK_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {blockChoice === 'Other' && (
            <input aria-label="Other reason" value={blockOther} onChange={(e) => setBlockOther(e.target.value)} />
          )}
          <button type="button" className="btn" onClick={block} disabled={busy}>
            Block this job
          </button>
        </div>
      )}

      {overrideOpen && (
        <div className="stack">
          <label className="field-label" htmlFor="override-reason">
            Why clear this block?
          </label>
          <input id="override-reason" value={reasonValue} onChange={(e) => setReasonValue(e.target.value)} />
          <button type="button" className="btn" onClick={override} disabled={busy || !reasonValue.trim()}>
            Clear block
          </button>
        </div>
      )}

      <div className="sec">
        <h3>Sources</h3>
        {job.sources.map((s) => (
          <div className="source" key={s.id}>
            <p>
              <strong>{s.title}</strong> / {s.company ?? 'Company not stated'}
            </p>
            <p className="muted">
              {s.match_type === 'origin' ? 'First alert' : `Grouped by ${s.match_type}`}, received{' '}
              {new Date(s.alert_received_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}
              {s.observations > 1 ? `, seen in ${s.observations} alerts` : ''}
            </p>
            {job.sources.length > 1 && (
              <button type="button" className="linkish" onClick={() => run(() => api.post(`jobs/${jobId}/split`, { posting_id: s.id }), 'Split. The listing is its own job now.')} disabled={busy}>
                Split this listing
              </button>
            )}
          </div>
        ))}
        {job.weak_matches.map((w) => (
          <div className="source" key={`weak-${w.jobId}`}>
            <p>
              Similar listing: <strong>{w.title}</strong> / {w.company ?? 'Company not stated'}
            </p>
            <p className="muted">Same company and a similar title. Kept separate until you group them.</p>
            <button type="button" className="btn btn-dark" onClick={() => run(() => api.post(`jobs/${jobId}/group`, { from_job_id: w.jobId }), 'Grouped. Both listings sit under this job.')} disabled={busy}>
              Keep grouped
            </button>
          </div>
        ))}
      </div>

      <p className="foot-note">
        Weights v{job.score_version ?? '-'}, {job.mode === 'ai' ? 'scored with AI extraction' : 'scored with rules only, low confidence'}.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="btn btn-dark" onClick={onClose}>
        Close panel
      </button>
    </div>
  );
}
