import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { DirectFilter, Filter, JobsResponse, RefreshStatus, SortKey } from '../../shared/types.ts';
import { APP_CONSTANTS } from '../../shared/types.ts';
import { clock } from '../format.ts';
import { UndoToast } from '../common/Toast.tsx';
import { RefreshDialog } from './RefreshDialog.tsx';
import { Detail } from './Detail.tsx';
import { JobList } from './JobList.tsx';
import { useSmallScreen } from '../hooks.ts';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'good', label: 'Good fit' },
  { key: 'review', label: 'Review' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'applied', label: 'Applied' },
  { key: 'closed', label: 'Closed' },
  { key: 'targets', label: 'Targets' },
];
const SORTS: SortKey[] = ['score', 'age', 'pay', 'confidence', 'targets'];
const DIRECTS: DirectFilter[] = ['any', 'tier1', 'tier2plus'];
const SORT_LABEL: Record<SortKey, string> = { score: 'score', age: 'age', pay: 'pay', confidence: 'confidence', targets: 'targets first' };
const DIRECT_LABEL: Record<DirectFilter, string> = { any: 'any', tier1: 'tier 1', tier2plus: 'tier 2 or higher' };

interface Stats {
  new_since_refresh: number;
  good_fit: number;
  applied: number;
}

function readParam<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = new URLSearchParams(window.location.search).get(name) as T | null;
  return v && allowed.includes(v) ? v : fallback;
}

export function Inbox(props: {
  onOpenSetup: () => void;
  onOpenWeights: () => void;
  refreshSignal: number;
  onRefreshStatus: (status: RefreshStatus) => void;
  onNotice: (m: string) => void;
  gmailNeedsAttention: boolean;
  aiNeedsAttention: boolean;
}) {
  const small = useSmallScreen();
  const [filter, setFilter] = useState<Filter>(() => readParam('filter', ['all', 'good', 'review', 'blocked', 'applied', 'closed', 'targets'] as const, 'all'));
  const [sort, setSort] = useState<SortKey>(() => readParam('sort', SORTS, 'score'));
  const [direct, setDirect] = useState<DirectFilter>(() => readParam('direct', DIRECTS, 'any'));
  const [data, setData] = useState<JobsResponse | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const [toast, setToast] = useState<{ jobId: number; message: string } | null>(null);
  const [collapsing, setCollapsing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogHidden, setDialogHidden] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const wasRunning = useRef(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Keep the filters in the URL so they survive a reload.
  useEffect(() => {
    const p = new URLSearchParams();
    p.set('filter', filter);
    p.set('sort', sort);
    p.set('direct', direct);
    window.history.replaceState(null, '', `?${p.toString()}`);
  }, [filter, sort, direct]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ filter, sort, direct });
      const [jobs, s] = await Promise.all([api.get<JobsResponse>(`jobs?${params}`), api.get<Stats>('stats')]);
      setData(jobs);
      setStats(s);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The Inbox could not load.');
    }
  }, [filter, sort, direct]);

  useEffect(() => {
    void load();
  }, [load, props.refreshSignal]);

  // Poll the refresh only while it runs. Nothing polls on a timer otherwise.
  const { onRefreshStatus } = props;
  const pollRefresh = useCallback(async () => {
    const s = await api.get<RefreshStatus>('refresh');
    setStatus(s);
    onRefreshStatus(s);
    return s;
  }, [onRefreshStatus]);

  useEffect(() => {
    void pollRefresh().catch(() => undefined);
    // Only on first mount: read the current state without starting anything.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const running = status?.running ?? false;
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      setDialogHidden(false);
    } else if (wasRunning.current) {
      wasRunning.current = false;
      setCancelling(false);
      const s = status?.scoring;
      const c = status?.last?.counts;
      if (c) props.onNotice(`Refresh finished. ${c.inserted ?? 0} new postings, ${s?.scored ?? 0} jobs scored.`);
    }
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(async () => {
      const s = await pollRefresh().catch(() => null);
      if (s && !s.running) {
        window.clearInterval(t);
        void load();
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [running, pollRefresh, load]);

  // Writes the ranked export file. The button shows the checksum and time in the notice.
  const exportFile = async () => {
    setBusy(true);
    try {
      const out = await api.post<{ file: string; checksum: string; jobs: number; generated_at: string }>('export/file', {});
      props.onNotice(`Exported ${out.jobs} jobs to ${out.file}. Checksum ${out.checksum.slice(0, 16)}. ${clock(out.generated_at)}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The export did not run.');
    } finally {
      setBusy(false);
    }
  };

  const cancelRefresh = async () => {
    setCancelling(true);
    await api.post('refresh/cancel', {}).catch(() => undefined);
  };

  const startRefresh = async () => {
    try {
      await api.post('refresh', {});
      await pollRefresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The refresh did not start.');
    }
  };

  const jobs = useMemo(() => data?.items ?? [], [data]);
  const selectedVisible = jobs.some((j) => j.id === selectedId);

  // Verdicts update the row at once and then reload.
  const verdict = async (id: number, v: 'good' | 'maybe' | 'bad') => {
    try {
      await api.post(`jobs/${id}/verdict`, { verdict: v, reason_tags: [], note: null });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The verdict did not save.');
    }
  };

  const quickProgress = (id: number) => {
    setSelectedId(id);
  };

  // The row collapses for 200ms, then the list reloads without it. Undo brings it back.
  const onBlocked = (jobId: number) => {
    setToast({ jobId, message: 'Blocked. This job is hidden from the Inbox.' });
    setSelectedId(null);
    setCollapsing(jobId);
    window.setTimeout(() => {
      setCollapsing(null);
      void load();
    }, 200);
  };

  const undo = async () => {
    if (!toast) return;
    try {
      await api.post(`jobs/${toast.jobId}/undo-block`, {});
      props.onNotice('Block undone.');
    } catch {
      props.onNotice('Undo window passed. Use Override and review on the blocked job.');
    }
    setToast(null);
    await load();
  };

  const closeSelection = useCallback(() => setSelectedId(null), []);

  // Escape closes the sheet on phone and the panel on desktop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedId !== null && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) {
        closeSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, closeSelection]);

  // Focus moves to the sheet heading on open and goes back to the row on close.
  useEffect(() => {
    if (selectedId !== null && small) {
      window.setTimeout(() => headingRef.current?.focus(), 0);
    }
  }, [selectedId, small]);

  const lastRefreshText = status?.completed_at ? clock(status.completed_at) : null;
  const counts = data?.counts ?? { all: 0, good: 0, review: 0, blocked: 0, applied: 0, closed: 0, targets: 0 };
  const filtersOn = filter !== 'all' || direct !== 'any';
  const emptyText = `Nothing new since ${lastRefreshText ?? 'the first refresh'}.`;
  const clearFilters = () => {
    setFilter('all');
    setDirect('any');
  };
  const showSplit = !small && selectedId !== null && selectedVisible;
  const showSheet = small && selectedId !== null && selectedVisible;

  const progress = status?.progress;
  const aiOff = props.aiNeedsAttention;
  const gmailOff = props.gmailNeedsAttention;

  return (
    <section className="inbox" aria-labelledby="inbox-title">
      <div className="hd">
        <h1 id="inbox-title" className="title">
          Inbox
        </h1>
        <div className="stats" aria-label="Summary">
          <div className="stat">
            <b key={`n-${stats?.new_since_refresh}`} className="tick">{stats?.new_since_refresh ?? '-'}</b>
            <span>New since refresh</span>
          </div>
          <div className="stat">
            <b key={`g-${stats?.good_fit}`} className="tick">{stats?.good_fit ?? '-'}</b>
            <span>Good fit</span>
          </div>
          <div className="stat">
            <b key={`a-${stats?.applied}`} className="tick">{stats?.applied ?? '-'}</b>
            <span>Applied</span>
          </div>
        </div>
      </div>

      <div className="refresh-line">
        <div className="refresh-meta">
          <span className="mono">Last refresh {lastRefreshText ?? 'not yet'}</span>
          <div className="row-actions">
            <button type="button" className="btn btn-dark" onClick={exportFile} disabled={busy}>
              Export JSON
            </button>
            <button type="button" className="btn" onClick={startRefresh} disabled={running}>
              {running ? 'Refreshing' : 'Refresh now'}
            </button>
          </div>
        </div>
        {running && (
          <div className="progress" role="status" aria-live="polite">
            <div className="progress-bar">
              <i style={{ width: progress && progress.total ? `${Math.round((progress.done / progress.total) * 100)}%` : '8%' }} />
            </div>
            <div className="row-actions">
              <span className="mono">
                {progress && progress.total ? `${progress.done} of ${progress.total} alert emails read` : 'Reading alerts'}
              </span>
              <button type="button" className="btn btn-dark" onClick={() => api.post('refresh/cancel', {}).catch(() => undefined)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {status?.last_error && (
          <p className="alert" role="alert">
            The last refresh failed: {status.last_error}{' '}
            <button type="button" className="linkish" onClick={props.onOpenSetup}>
              View setup
            </button>
          </p>
        )}
        {status?.last?.status === 'failed' && (
          <p className="alert" role="alert">
            The last refresh could not read Gmail. {status.last.errors?.[0]?.error ?? 'The reason is in the log.'}{' '}
            <button type="button" className="linkish" onClick={props.onOpenSetup}>
              View setup
            </button>
          </p>
        )}
        {(status?.scoring?.remaining ?? 0) > 0 && (
          <p className="note" role="status">
            {status?.scoring?.remaining} jobs are waiting to be scored. They are scored on later refreshes, newest first.
          </p>
        )}
        {status?.last?.status === 'partial' && (
          <p className="notice notice-clay" role="status">
            Refresh finished with problems. {status.last.counts.fetchErrors ?? 0} fetch errors, {status.last.counts.parseErrors ?? 0} alerts not read. Other results are kept.
          </p>
        )}
        {gmailOff && (
          <p className="notice notice-clay" role="status">
            Gmail needs reconnecting.{' '}
            <button type="button" className="linkish" onClick={props.onOpenSetup}>
              Reconnect Gmail
            </button>
          </p>
        )}
        {aiOff && (
          <p className="notice notice-clay" role="status">
            Rules only scoring, low confidence. Scores here do not include AI factor values.{' '}
            <button type="button" className="linkish" onClick={props.onOpenSetup}>
              Reconnect ChatGPT
            </button>
          </p>
        )}
      </div>

      <div className="filters">
        <div className="seg" role="group" aria-label="Filter jobs">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              <span className="n">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="pill"
          onClick={() => setSort(SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length] ?? 'score')}
        >
          Sort: {SORT_LABEL[sort]}
        </button>
        <button
          type="button"
          className="pill"
          onClick={() => setDirect(DIRECTS[(DIRECTS.indexOf(direct) + 1) % DIRECTS.length] ?? 'any')}
        >
          Direct: {DIRECT_LABEL[direct]}
        </button>
        <button type="button" className="pill" onClick={props.onOpenWeights}>
          Scoring settings
        </button>
      </div>

      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}

      <div className={`split${showSplit ? ' has-panel' : ''}`}>
        {showSplit && selectedId !== null && (
          <aside className="panel" aria-label="Selected job">
            <button type="button" className="panel-x" aria-label="Close panel" title="Close panel" onClick={closeSelection}>
              ×
            </button>
            <Detail
              jobId={selectedId}
              onChanged={load}
              onBlocked={onBlocked}
              onNotice={props.onNotice}
              onClose={closeSelection}
              headingRef={headingRef}
            />
          </aside>
        )}
        <div className="list-wrap">
          <JobList
            jobs={jobs}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onVerdict={verdict}
            onQuickProgress={quickProgress}
            small={small}
            emptyText={emptyText}
            collapsing={collapsing}
          />
          {jobs.length === 0 && (
            <div className="empty-actions">
              <p className="mono">Total in the app: {counts.all} jobs in All.</p>
              {filtersOn && (
                <button type="button" className="btn btn-dark" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {showSheet && selectedId !== null && (
        <div className="sheet" role="dialog" aria-modal="true" aria-label="Job detail">
          <div className="sheet-back">
            <button type="button" className="btn" onClick={closeSelection}>
              Back to list
            </button>
            <button type="button" className="btn btn-dark sheet-x" aria-label="Close" title="Close" onClick={closeSelection}>
              ×
            </button>
          </div>
          <Detail
            jobId={selectedId}
            onChanged={load}
            onBlocked={onBlocked}
            onNotice={props.onNotice}
            onClose={closeSelection}
            headingRef={headingRef}
          />
        </div>
      )}

      {running && !dialogHidden && (
        <RefreshDialog progress={status?.progress ?? null} onHide={() => setDialogHidden(true)} onCancel={cancelRefresh} cancelling={cancelling} />
      )}

      {toast && <UndoToast message={toast.message} ms={APP_CONSTANTS.undoMs} onUndo={undo} onDone={() => setToast(null)} />}

      <footer className="foot">
        <p>Nothing refreshes itself.</p>
        <p>You press the button.</p>
      </footer>
    </section>
  );
}
