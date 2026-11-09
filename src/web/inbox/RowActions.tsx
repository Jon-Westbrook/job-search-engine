// The job actions shared by every list. Open listing is always there. The decisions depend on the
// job's state, so the same buttons work in the Inbox, the Targets view, and Network.
export type Decide = 'progress' | 'applied' | 'not_interested' | 'not_available' | 'bring_back' | 'reopen';

export const DECIDE_LABEL: Record<Decide, string> = {
  progress: 'Progress',
  applied: 'Applied',
  not_interested: 'Not interested',
  not_available: 'Not available',
  bring_back: 'Bring back',
  reopen: 'Reopen',
};

interface RowActionsProps {
  actions: Decide[];
  // Actions that already happened. They stay visible but cannot be pressed again.
  done?: Decide[];
  count: number;
  onOpen: () => void;
  onDecide: (action: Decide) => void;
}

// count is the number of selected rows when this row is one of several. The buttons then say so.
export function RowActions({ actions, done = [], count, onOpen, onDecide }: RowActionsProps) {
  return (
    <div className="row-actions">
      <button type="button" className="btn btn-dark" data-row-button onClick={onOpen}>
        Open listing
      </button>
      {actions.map((action) => (
        <button key={action} type="button" className={action === 'progress' || action === 'applied' ? 'btn' : 'btn btn-dark'} data-row-button disabled={done.includes(action)} onClick={() => onDecide(action)}>
          {DECIDE_LABEL[action]}
          {count > 1 ? ` ${count}` : ''}
        </button>
      ))}
    </div>
  );
}
