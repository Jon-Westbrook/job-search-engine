import { APP_NAME } from '../shared/app.ts';

// C1 shell. The Inbox screen arrives in C5.
export function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">{APP_NAME}</div>
      </header>
      <h1 className="page-title">Inbox</h1>
      <p className="empty">Nothing loaded yet. The Inbox arrives in the next checkpoint.</p>
    </div>
  );
}
