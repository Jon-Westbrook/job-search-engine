import { useEffect, useRef, type ReactNode } from 'react';

// Accessible dialog: focus moves in on open, Esc closes, focus returns to the opener.
export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const { title, onClose, children, wide } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('h2')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog${wide ? ' dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title" ref={ref}>
        <header className="dialog-head">
          <h2 id="dialog-title" tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="btn btn-dark" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
