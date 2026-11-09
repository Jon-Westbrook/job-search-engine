import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api.ts';
import type { DirectFilter, Filter, JobListItem, JobsResponse, RefreshStatus, ResultRow, ResultsResponse, SavedView } from '../../shared/types.ts';
import { clock } from '../format.ts';
import { RefreshDialog } from './RefreshDialog.tsx';
import { JobList, SORT_KEYS, defaultDir, matchesSearch, sortJobs, type SortKey, type SortState } from './JobList.tsx';
import type { Decide } from './RowActions.tsx';
import { DONE, openListing, sendDecision } from './useJobDecisions.ts';
import { useSmallScreen } from '../hooks.ts';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'undecided', label: 'Undecided' },
  { key: 'good', label: 'Good fit' },
  { key: 'targets', label: 'Targets' },
  { key: 'progressed', label: 'Progressed' },
  { key: 'not_interested', label: 'Not interested' },
  { key: 'not_available', label: 'Not available' },
];
const FILTER_KEYS = FILTERS.map((f) => f.key);
const DIRECTS: DirectFilter[] = ['any', 'tier1', 'tier2plus'];
const DIRECT_LABEL: Record<DirectFilter, string> = { any: 'any', tier1: 'tier 1', tier2plus: 'tier 2 or higher' };
// The list renders this many rows at a time. The rest appear on request.
const CHUNK = 150;

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
  const [query, setQuery] = useState('');
  const [data, setData] = useState<JobsResponse | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [views, setViews] = useState<SavedView[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [shown, setShown] = useState(CHUNK);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RefreshStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogHidden, setDialogHidden] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const wasRunning = useRef(false);

  // Filters and sort stay in the URL so they survive a reload.
  useEffect(() => {
    const p = new URLSearchParams();
    p.set('filter', filter);
    p.set('sort', sort.key);
    p.set('dir', sort.dir);
    p.set('direct', direct);
    window.history.replaceState(null, '', `?${p.toString()}`);
  }, [filter, sort, direct]);

  // A new view starts with a clear selection and the first page of rows.
  useEffect(() => {
    setShown(CHUNK);
    setSelected(new Set());
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

  useEffect(() => {
    api
      .get<{ views: SavedView[] }>('views')
      .then((d) => setViews(d.views))
      .catch(() => undefined);
  }, []);

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

  const sorted = useMemo(() => sortJobs((data?.items ?? []).filter((j) => matchesSearch(j, query)), sort), [data, sort, query]);
  const visible = sorted.slice(0, shown);

  // A new column starts in its default direction. The same column again reverses it.
  const onSort = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir(key) }));
  };

  const pick = (id: number) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pickAll = (ids: number[], on: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  // A decision on a row applies to every selected row when the row is one of several selected.
  // Rows leave the list at once. The request runs behind them, and rows it could not change come back.
  const decide = async (job: JobListItem, action: Decide) => {
    const ids = selected.has(job.id) && selected.size > 1 ? [...selected] : [job.id];
    const gone = new Set(ids);
    setData((d) => d && { ...d, items: d.items.filter((j) => !gone.has(j.id)), counts: { ...d.counts, [filter]: Math.max(0, (d.counts[filter] ?? 0) - ids.length) } });
    setSelected(new Set());
    try {
      const out = await sendDecision(ids, action);
      props.onNotice(`${out.done} ${out.done === 1 ? 'job' : 'jobs'} ${DONE[action]}.`);
      if (out.failed.length > 0) {
        setError(`${out.failed.length} could not change and are back in the list.`);
        void load();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The jobs did not update.');
      void load();
    }
  };

  const saveViews = (next: SavedView[]) => {
    setViews(next);
    api.post('views', { views: next }).catch(() => setError('The saved view did not save.'));
  };

  // A saved view is named after its search text, or after its filter when there is no search.
  const saveCurrentView = () => {
    const name = query.trim() || FILTERS.find((f) => f.key === filter)?.label || 'View';
    saveViews([...views.filter((v) => v.name !== name), { name, filter, q: query }]);
  };

  const openView = (v: SavedView) => {
    setFilter(v.filter as Filter);
    setQuery(v.q);
  };

  const loadResults = () => {
    api
      .get<ResultsResponse>('results')
      .then(setResults)
      .catch(() => undefined);
  };

  const lastRefreshText = status?.completed_at ? clock(status.completed_at) : null;
  const counts: Partial<Record<Filter, number>> = data?.counts ?? {};
  const filtersOn = filter !== 'undecided' || direct !== 'any' || query !== '';
  const emptyText = `Nothing new since ${lastRefreshText ?? 'the first refresh'}.`;
  const clearFilters = () => {
    setFilter('undecided');
    setDirect('any');
    setQuery('');
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
        <label className="search">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M15.5 15.5 21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input type="search" value={query} placeholder="Search" aria-label="Search jobs" onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      <div className="saved-views" aria-label="Saved views">
          {views.map((v) => (
            <span key={v.name} className="tg dir view-chip">
              <button type="button" onClick={() => openView(v)}>
                {v.name}
              </button>
              <button type="button" aria-label={`Remove ${v.name}`} onClick={() => saveViews(views.filter((x) => x.name !== v.name))}>
                ×
              </button>
            </span>
          ))}
          <button type="button" className="pill" onClick={saveCurrentView}>
            Save this view
          </button>
        </div>

      {selected.size > 0 && (
        <div className="selbar" role="status">
          <span className="mono">{selected.size} selected. A button on any selected row applies to all of them.</span>
          <button type="button" className="linkish" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

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
          selected={selected}
          onSort={onSort}
          onPick={pick}
          onPickAll={pickAll}
          onOpen={(job) => openListing(job, small)}
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
