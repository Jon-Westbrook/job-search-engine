import { useEffect } from 'react';

// Undo toast for a block (brief section 19). It stays for five seconds, then goes away.
export function UndoToast(props: { message: string; onUndo: () => void; onDone: () => void; ms: number }) {
  const { message, onUndo, onDone, ms } = props;
  useEffect(() => {
    const t = window.setTimeout(onDone, ms);
    return () => window.clearTimeout(t);
  }, [onDone, ms]);
  return (
    <div className="toast" role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" className="btn btn-coral" onClick={onUndo}>
        Undo
      </button>
    </div>
  );
}
