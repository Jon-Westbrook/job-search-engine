import { useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Modal } from '../common/Modal.tsx';

interface GmailHealth {
  connected: boolean;
  reason?: string;
}
interface StartGmail {
  status: 'confirm_required' | 'link_ready' | 'failed';
  message?: string;
  url?: string;
  steps?: string[];
}
interface CodexStatus {
  available: boolean;
  detail: string;
}
interface CodexStart {
  url: string;
  code: string;
  steps: string[];
}

// Sign-in steps for Gmail and ChatGPT. the owner does the clicks himself. The app only
// shows the links and checks the result. Nothing here runs on launch.
export function SetupDialog(props: { onClose: () => void }) {
  const [gmail, setGmail] = useState<GmailHealth | null>(null);
  const [gmailStart, setGmailStart] = useState<StartGmail | null>(null);
  const [pasted, setPasted] = useState('');
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [codexStart, setCodexStart] = useState<CodexStart | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checkGmail = async () => {
    setBusy(true);
    try {
      setGmail(await api.get<GmailHealth>('setup/gmail'));
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Gmail check failed.');
    } finally {
      setBusy(false);
    }
  };

  const startGmail = async (confirm: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const out = await api.post<StartGmail>('setup/gmail/start', { confirm_replace: confirm });
      setGmailStart(out);
      if (out.status === 'failed') setMessage(out.message ?? 'Sign-in could not start.');
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Sign-in could not start.');
    } finally {
      setBusy(false);
    }
  };

  const finishGmail = async () => {
    const value = pasted;
    setPasted('');
    setBusy(true);
    try {
      await api.post('setup/gmail/finish', { redirect_url: value });
      setMessage('Gmail is connected.');
      setGmailStart(null);
      setGmail({ connected: true });
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'That address did not work. Copy the full address and try again.');
    } finally {
      setBusy(false);
    }
  };

  const checkCodex = async () => {
    setBusy(true);
    try {
      setCodex(await api.get<CodexStatus>('setup/codex'));
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'ChatGPT check failed.');
    } finally {
      setBusy(false);
    }
  };

  const startCodex = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setCodexStart(await api.post<CodexStart>('setup/codex/start'));
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Sign-in could not start.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Setup" onClose={props.onClose} wide>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}

      <section className="sec">
        <h3>Gmail</h3>
        <p>
          Status: {gmail === null ? 'not checked yet' : gmail.connected ? 'connected' : `needs reconnecting (${gmail.reason ?? 'unknown reason'})`}
        </p>
        <div className="row-actions">
          <button type="button" className="btn btn-dark" onClick={checkGmail} disabled={busy}>
            Check Gmail
          </button>
          <button type="button" className="btn" onClick={() => startGmail(false)} disabled={busy}>
            Sign in to Gmail
          </button>
        </div>

        {gmailStart?.status === 'confirm_required' && (
          <div className="notice notice-clay" role="group" aria-label="Confirm sign-in">
            <p>{gmailStart.message}</p>
            <button type="button" className="btn" onClick={() => startGmail(true)} disabled={busy}>
              Sign in again anyway
            </button>
          </div>
        )}

        {gmailStart?.status === 'link_ready' && gmailStart.url && (
          <div className="stack">
            <p>
              <a className="linkish" href={gmailStart.url} target="_blank" rel="noopener noreferrer">
                Open the Google sign-in
              </a>
            </p>
            <ol className="steps">
              {(gmailStart.steps ?? []).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <label className="field-label" htmlFor="redirect-paste">
              Address from the browser after Google sends you back
            </label>
            <input
              id="redirect-paste"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
            <p className="note">This address is used once and then cleared. It is not stored.</p>
            <button type="button" className="btn" onClick={finishGmail} disabled={busy || !pasted.trim()}>
              Finish Gmail sign-in
            </button>
          </div>
        )}
      </section>

      <section className="sec">
        <h3>ChatGPT (scoring)</h3>
        <p>Status: {codex === null ? 'not checked yet' : codex.available ? codex.detail : `not signed in (${codex.detail})`}</p>
        <div className="row-actions">
          <button type="button" className="btn btn-dark" onClick={checkCodex} disabled={busy}>
            Check ChatGPT
          </button>
          <button type="button" className="btn" onClick={startCodex} disabled={busy}>
            Start ChatGPT sign-in
          </button>
        </div>
        {codexStart && (
          <div className="stack">
            <p>
              <a className="linkish" href={codexStart.url} target="_blank" rel="noopener noreferrer">
                Open the ChatGPT sign-in page
              </a>
            </p>
            <p className="code" aria-label="One-time code">
              {codexStart.code}
            </p>
            <ol className="steps">
              {codexStart.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <button type="button" className="btn btn-dark" onClick={checkCodex} disabled={busy}>
              Check sign-in
            </button>
          </div>
        )}
      </section>
    </Modal>
  );
}
