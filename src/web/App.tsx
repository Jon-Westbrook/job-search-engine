import { useCallback, useState } from 'react';
import { APP_NAME } from '../shared/app.ts';
import type { RefreshStatus } from '../shared/types.ts';
import { Inbox } from './inbox/Inbox.tsx';
import { SetupDialog } from './setup/SetupDialog.tsx';
import { WeightsDialog } from './settings/Weights.tsx';
import { Tracker } from './tracker/Tracker.tsx';

type Tab = 'inbox' | 'analysis' | 'submit' | 'tracker';
const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'submit', label: 'Submit' },
  { key: 'tracker', label: 'Tracker' },
];

const PLACEHOLDER: Record<'analysis' | 'submit', string> = {
  analysis: 'Analysis ships in Phase 2.',
  submit: 'Submit ships in Phase 3.',
};

export function App() {
  const [tab, setTab] = useState<Tab>('inbox');
  const [setupOpen, setSetupOpen] = useState(false);
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<RefreshStatus | null>(null);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 4000);
  }, []);

  const gmailNeedsAttention = Boolean(status?.last_error && /gog|gmail|token|auth/i.test(status.last_error));
  const aiNeedsAttention = status?.scoring?.ai_available === false;

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">{APP_NAME}</div>
        <nav className="tabs" aria-label="Workspaces">
          {TABS.map((t) => (
            <button key={t.key} type="button" className="tab" aria-current={tab === t.key ? 'page' : undefined} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="bar-r">
          <button type="button" className="btn btn-dark" onClick={() => setSetupOpen(true)}>
            Setup
          </button>
        </div>
      </header>

      <main className="main">
        {tab === 'inbox' ? (
          <Inbox
            refreshSignal={refreshSignal}
            onOpenSetup={() => setSetupOpen(true)}
            onOpenWeights={() => setWeightsOpen(true)}
            onRefreshStatus={setStatus}
            onNotice={flash}
            gmailNeedsAttention={gmailNeedsAttention}
            aiNeedsAttention={aiNeedsAttention}
          />
        ) : tab === 'tracker' ? (
          <Tracker onNotice={flash} />
        ) : (
          <section className="placeholder" aria-label={TABS.find((t) => t.key === tab)?.label}>
            <h1 className="title">{TABS.find((t) => t.key === tab)?.label}</h1>
            <p className="empty">{PLACEHOLDER[tab]}</p>
          </section>
        )}
      </main>

      <nav className="bottom-nav" aria-label="Workspaces, phone">
        {TABS.map((t) => (
          <button key={t.key} type="button" aria-current={tab === t.key ? 'page' : undefined} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </nav>

      {notice && (
        <p className="notice-line" role="status" aria-live="polite">
          {notice}
        </p>
      )}
      {setupOpen && <SetupDialog onClose={() => setSetupOpen(false)} />}
      {weightsOpen && (
        <WeightsDialog
          onClose={() => setWeightsOpen(false)}
          onSaved={() => {
            flash('Weights saved as a new version. Existing scores keep their version.');
            setRefreshSignal((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
