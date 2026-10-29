import { useEffect, useRef } from 'react';

type Phase = 'searching' | 'downloading' | 'processing' | 'scoring';

const STEPS: Array<{ key: 'download' | 'process' | 'score'; label: string; phases: Phase[] }> = [
  { key: 'download', label: 'Download alerts from Gmail', phases: ['searching', 'downloading'] },
  { key: 'process', label: 'Sort postings into jobs', phases: ['processing'] },
  { key: 'score', label: 'Score new and changed jobs', phases: ['scoring'] },
];

export interface RefreshDialogProps {
  progress: { phase: Phase; done: number; total: number; messages: number } | null;
  onHide: () => void;
  onCancel: () => void;
  cancelling: boolean;
}

// Shows what a refresh is doing: download, sort, score, with live counts (brief 20 "Refreshing").
export function RefreshDialog(props: RefreshDialogProps) {
  const { progress, onHide, onCancel, cancelling } = props;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('h2')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onHide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onHide]);

  const phase: Phase = progress?.phase ?? 'searching';
  const activeIndex = STEPS.findIndex((s) => s.phases.includes(phase));
  const hasTotal = progress !== null && progress.total > 0 && (phase === 'downloading' || phase === 'scoring');
  const pct = hasTotal && progress ? Math.round((progress.done / progress.total) * 100) : null;

  let detail = 'Starting the refresh.';
  if (phase === 'searching') detail = 'Searching Gmail for new job alerts.';
  if (phase === 'downloading' && progress) detail = `${progress.done} of ${progress.total} alert threads downloaded. ${progress.messages} messages read.`;
  if (phase === 'processing') detail = 'Sorting the new postings into jobs and matching duplicates.';
  if (phase === 'scoring' && progress) detail = `Scored ${progress.done} of ${progress.total} jobs.`;

  return (
    <div className="scrim" role="presentation">
      <div className="dialog refresh-dialog" role="dialog" aria-modal="true" aria-labelledby="refresh-title" ref={ref}>
        <header className="dialog-head">
          <h2 id="refresh-title" tabIndex={-1}>
            {cancelling ? 'Stopping' : 'Refreshing'}
          </h2>
        </header>
        <div className="dialog-body">
          <ol className="phases">
            {STEPS.map((s, i) => {
              const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'waiting';
              return (
                <li key={s.key} className={`phase ${state}`} aria-current={state === 'active' ? 'step' : undefined}>
                  <span className="phase-mark" aria-hidden="true">
                    {state === 'done' ? '✓' : i + 1}
                  </span>
                  <span>{s.label}</span>
                </li>
              );
            })}
          </ol>

          <div className={`stripes${pct === null ? ' indeterminate' : ''}`} role="progressbar" aria-label="Refresh progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
            <i style={pct === null ? undefined : { width: `${pct}%` }} />
          </div>
          <p className="mono" role="status" aria-live="polite">
            {detail}
          </p>

          <div className="row-actions">
            <button type="button" className="btn btn-dark" onClick={onHide}>
              Hide
            </button>
            <button type="button" className="btn" onClick={onCancel} disabled={cancelling}>
              {cancelling ? 'Stopping after this step' : 'Cancel refresh'}
            </button>
          </div>
          <p className="note">Hiding keeps the refresh running. You can keep working.</p>
        </div>
      </div>
    </div>
  );
}
