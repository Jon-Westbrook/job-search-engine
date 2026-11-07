import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { DirectFilter, Filter, JobListItem, JobsResponse, RefreshStatus, ResultRow, ResultsResponse } from '../../shared/types.ts';
import { clock } from '../format.ts';
import { RefreshDialog } from './RefreshDialog.tsx';
import { JobList, SORT_KEYS, defaultDir, sortJobs, type Decide, type SortKey, type SortState } from './JobList.tsx';
import { useSmallScreen } from '../hooks.ts';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'undecided', label: 'Undecided' },
  { key: 'good', label: 'Good fit' },
  { key: 'review', label: 'Review' },
  { key: 'progressed', label: 'Progressed' },
  { key: 'not_interested', label: 'Not interested' },
  { key: 'not_available', label: 'Not available' },
  { key: 'blocked', label: 'Blocked' },
];
const FILTER_KEYS = FILTERS.map((f) => f.key);
const DIRECTS: DirectFilter[] = ['any', 'tier1', 'tier2plus'];
const DIRECT_LABEL: Record<DirectFilter, string> = { any: 'any', tier1: 'tier 1', tier2plus: 'tier 2 or higher' };
// The list renders this many rows at a time. The rest appear on request, so a long queue stays quick.
const CHUNK = 150;
const NOTICE: Record<Decide, string> = {
  progress: 'Saved to Analysis.',
  not_interested: 'Marked not interested.',
  not_available: 'Marked not available.',
  bring_back: 'Brought back to Undecided.',
  reopen: 'Reopened.',
};

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
  const [filter, setFilter] = useState<Filter>(() => readParam('filter', FILTER_KEYS, 'undecided'));
  const [sort, setSort] = useState<SortState>(() => {
    const key = readParam('sort', SORT_KEYS, 'score');
    return { key, dir: readParam('dir', ['asc', 'desc'] as const, defaultDir(key)) };
  });
  const [direct, setDirect] = useState<DirectFilter>(() => readParam('direct', DIRECTS, 'any'));
  const [data, setData] = useState<JobsResponse | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [shown, setShown] = useState(CHUNK);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogHidden, setDialogHidden] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const wasRunning = useRef(false);

  // Keep the filters and sort in the URL so they survive a reload.
  useEffect(() => {
    const p = new URLSearchParams();
    p.set('filter', filter);
    p.set('sort', sort.key);
    p.set('dir', sort.dir);
    p.set('direct', direct);
    window.history.replaceState(null, '', `?${p.toString()}`);
  }, [filter, sort, direct]);

  useEffect(() => {
    setShown(CHUNK);
  }, [filter, direct]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ filter, direct });
      const [jobs, s] = await Promise.all([api.get<JobsResponse>(`jobs?${params}`), api.get<Stats>('stats')]);
      setData(jobs);
      setStats(s);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The Inbox could not load.');
    }
  }, [filter, direct]);

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

  const sorted = useMemo(() => sortJobs(data?.items ?? [], sort), [data, sort]);
  const visible = sorted.slice(0, shown);

  // A new column starts in its default direction. The same column again reverses it.
  const onSort = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir(key) }));
  };

  // On a phone the listing opens in a new tab. On a computer it opens in one small window that is
  // reused, so a quick look does not pile up tabs. The owner opens it, not the app.
  const openListing = (job: JobListItem) => {
    if (small) window.open(job.url, '_blank', 'noopener');
    else window.open(job.url, 'autojob-listing', 'popup=yes,width=1040,height=900,noopener');
    api.post(`jobs/${job.id}/listing-opened`, {}).catch(() => undefined);
  };

  // Every decision removes the row at once. The request runs behind it. If it fails, the list reloads.
  const decide = async (job: JobListItem, action: Decide) => {
    setData((d) => d && { ...d, items: d.items.filter((j) => j.id !== job.id), counts: { ...d.counts, [filter]: Math.max(0, (d.counts[filter] ?? 0) - 1) } });
    try {
      if (action === 'progress') await api.post(`jobs/${job.id}/progress`, { reason: null });
      else if (action === 'not_interested') await api.post(`jobs/${job.id}/verdict`, { verdict: 'bad', reason_tags: [], note: null });
      else if (action === 'bring_back') await api.post(`jobs/${job.id}/verdict`, { verdict: 'maybe', reason_tags: [], note: null });
      else if (action === 'not_available') await api.post(`jobs/${job.id}/close`, { reason: 'Not available on LinkedIn' });
      else await api.post(`jobs/${job.id}/reopen`, {});
      props.onNotice(NOTICE[action]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The job did not update.');
      void load();
    }
  };

  const loadResults = () => {
    api
      .get<ResultsResponse>('results')
      .then(setResults)
      .catch(() => undefined);
  };

  const lastRefreshText = status?.completed_at ? clock(status.completed_at) : null;
  const counts: Partial<Record<Filter, number>> = data?.counts ?? {};
  const filtersOn = filter !== 'undecided' || direct !== 'any';
  const emptyText = `Nothing new since ${lastRefreshText ?? 'the first refresh'}.`;
  const clearFilters = () => {
    setFilter('undecided');
    setDirect('any');
  };

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
              <span className="n">{counts[f.key] ?? 0}</span>
            </button>
          ))}
        </div>
        <button type="button" className="pill" onClick={() => setDirect(DIRECTS[(DIRECTS.indexOf(direct) + 1) % DIRECTS.length] ?? 'any')}>
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

      <div className="list-wrap">
        <JobList
          jobs={visible}
          view={filter}
          sort={sort}
          onSort={onSort}
          onOpen={openListing}
          onDecide={decide}
          small={small}
          emptyText={emptyText}
        />
        {sorted.length > shown && (
          <div className="more-row">
            <button type="button" className="btn btn-dark" onClick={() => setShown((n) => n + CHUNK)}>
              Show {Math.min(CHUNK, sorted.length - shown)} more ({sorted.length - shown} left)
            </button>
          </div>
        )}
        {sorted.length === 0 && (
          <div className="empty-actions">
            <p className="mono">Total in the app: {counts.all ?? 0} jobs in All.</p>
            {filtersOn && (
              <button type="button" className="btn btn-dark" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      <details
        className="results"
        onToggle={(e) => {
          if (e.currentTarget.open) loadResults();
        }}
      >
        <summary>Your decisions</summary>
        {results && (
          <>
            <ResultsTable title="Channel" rows={results.by_channel} />
            <ResultsTable title="Score" rows={results.by_band} />
          </>
        )}
      </details>

      {running && !dialogHidden && (
        <RefreshDialog progress={status?.progress ?? null} onHide={() => setDialogHidden(true)} onCancel={cancelRefresh} cancelling={cancelling} />
      )}

      <footer className="foot">
        <p>Nothing refreshes itself.</p>
        <p>You press the button.</p>
      </footer>
    </section>
  );
}

function ResultsTable(props: { title: string; rows: ResultRow[] }) {
  return (
    <div className="list">
      <table>
        <thead>
          <tr>
            <th scope="col">{props.title}</th>
            <th scope="col">Undecided</th>
            <th scope="col">Progressed</th>
            <th scope="col">Not interested</th>
            <th scope="col">Not available</th>
            <th scope="col">Opened</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td>{r.undecided}</td>
              <td>{r.progressed}</td>
              <td>{r.not_interested}</td>
              <td>{r.not_available}</td>
              <td>{r.opened}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
