import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { Modal } from '../common/Modal.tsx';
import type { WeightProfileView } from '../../shared/types.ts';

const KEYS: Array<{ key: keyof WeightProfileView['weights']; label: string }> = [
  { key: 'tn', label: 'TN and visa fit' },
  { key: 'role', label: 'Role and resume fit' },
  { key: 'direct', label: 'Direct line' },
  { key: 'recency', label: 'Recency' },
  { key: 'compensation', label: 'Compensation' },
  { key: 'effort', label: 'Effort' },
];

interface Response {
  active: WeightProfileView;
  history: WeightProfileView[];
}

export function WeightsDialog(props: { onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<Response | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<Response>('settings/weights')
      .then((d) => {
        setData(d);
        setValues(Object.fromEntries(KEYS.map((k) => [k.key, String(d.active.weights[k.key])])));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Weights did not load.'));
  }, []);

  const total = KEYS.reduce((sum, k) => sum + (Number(values[k.key]) || 0), 0);
  const valid = Math.abs(total - 100) < 0.001 && reason.trim().length > 0 && KEYS.every((k) => Number(values[k.key]) >= 0);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const weights = Object.fromEntries(KEYS.map((k) => [k.key, Number(values[k.key])]));
      await api.post('settings/weights', { weights, reason: reason.trim() });
      props.onSaved();
      props.onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The weights did not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Scoring settings" onClose={props.onClose} wide>
      {!data && !error && <p className="muted">Loading the weights</p>}
      {data && (
        <>
          <p className="tagline">Weights v{data.active.version}</p>
          <p className="note">Each change creates a new version. Old scores keep the version they used. Weights must add to 100.</p>
          <div className="weights">
            {KEYS.map((k) => (
              <label key={k.key} className="weight">
                <span>{k.label}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={1}
                  value={values[k.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [k.key]: e.target.value }))}
                />
              </label>
            ))}
          </div>
          <p className={`total${Math.abs(total - 100) < 0.001 ? '' : ' bad'}`} role="status">
            Total {total} of 100
          </p>
          <label className="stack">
            <span className="field-label">Reason for this change</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="row-actions">
            <button type="button" className="btn" onClick={save} disabled={!valid || busy}>
              Save as version {data.active.version + 1}
            </button>
          </div>
          <h3 className="sec-title">History</h3>
          <ul className="history">
            {data.history.map((h) => (
              <li key={h.version}>
                v{h.version}, {new Date(h.created_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}:{' '}
                {h.reason ?? 'starting values'}
              </li>
            ))}
          </ul>
        </>
      )}
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
