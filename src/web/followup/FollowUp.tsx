import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import type { OutreachRecord } from '../../shared/types.ts';
import { followUpMessage, type OwnerMessage } from '../../shared/drafts.ts';
import { linkedInPlace } from '../../shared/person.ts';
import { shortDate } from '../format.ts';

// Messages sent to people about a role that have not had a reply yet, due ones first. The app never
// sends or reads LinkedIn; you mark each step by hand. Nothing is removed: finished rows stay visible.

interface Props {
  onNotice: (message: string) => void;
}

export function FollowUp({ onNotice }: Props) {
  const [items, setItems] = useState<OutreachRecord[] | null>(null);
  const [me, setMe] = useState<OwnerMessage>({});
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<{ id: number; text: string } | null>(null);

  function load() {
    return api
      .get<{ items: OutreachRecord[]; me: OwnerMessage }>('outreach')
      .then((data) => {
        setItems(data.items);
        setMe(data.me);
      })
      .catch(() => setError('The follow-up list did not load. Check that the server is running.'));
  }

  useEffect(() => {
    void load();
  }, []);

  async function act(record: OutreachRecord, action: string, message: string) {
    try {
      await api.patch(`outreach/${record.id}`, { action });
      onNotice(message);
      setDrafting(null);
      await load();
    } catch (err) {
      onNotice(err instanceof ApiError ? err.message : 'That did not save.');
    }
  }

  function startDraft(record: OutreachRecord) {
    if (drafting?.id === record.id) return setDrafting(null);
    setDrafting({ id: record.id, text: followUpMessage(record.person_name, record.company, record.job_title && record.job_url ? { title: record.job_title, url: record.job_url } : null, me) });
  }

  async function copy(text: string, then?: () => void) {
    try {
      await navigator.clipboard.writeText(text);
      onNotice(then ? 'Draft copied. On LinkedIn, click Message and paste. Then press "I followed up".' : 'Draft copied.');
      then?.();
    } catch {
      onNotice('Could not copy. Select the text and copy it by hand.');
    }
  }

  if (error) return <section className="placeholder" aria-label="Follow-up"><p className="empty">{error}</p></section>;
  if (items === null) return <section className="placeholder" aria-label="Follow-up"><p className="empty">Loading.</p></section>;

  const due = items.filter((r) => r.status === 'sent' && r.due);
  const waiting = items.filter((r) => r.status === 'sent' && !r.due);
  const done = items.filter((r) => r.status !== 'sent');

  return (
    <section className="followup" aria-label="Follow-up">
      <h1 className="title">Follow-up</h1>
      {items.length === 0 && <p className="empty">Nothing sent yet. Record a message from the Network tab with "I sent it".</p>}

      <Group title="Due now" rows={due} empty="Nothing due today.">
        {(r) => <Row record={r} drafting={drafting} onDraft={() => startDraft(r)} onCopy={copy} onAct={act} onEdit={(text) => setDrafting({ id: r.id, text })} />}
      </Group>
      <Group title="Waiting" rows={waiting} empty="Nothing waiting.">
        {(r) => <Row record={r} drafting={drafting} onDraft={() => startDraft(r)} onCopy={copy} onAct={act} onEdit={(text) => setDrafting({ id: r.id, text })} />}
      </Group>
      <Group title="Done" rows={done} empty="Nothing finished yet." muted>
        {(r) => <DoneRow record={r} />}
      </Group>
    </section>
  );
}

function Group({ title, rows, empty, muted, children }: { title: string; rows: OutreachRecord[]; empty: string; muted?: boolean; children: (r: OutreachRecord) => ReactNode }) {
  return (
    <div className={`followup-group${muted ? ' muted' : ''}`}>
      <h2 className="sec-title">
        {title} <span className="sub">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="sub">{empty}</p>
      ) : (
        <ul className="followup-list">
          {rows.map((r) => (
            <li key={r.id} className="followup-row">
              {children(r)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({
  record,
  drafting,
  onDraft,
  onCopy,
  onAct,
  onEdit,
}: {
  record: OutreachRecord;
  drafting: { id: number; text: string } | null;
  onDraft: () => void;
  onCopy: (text: string, then?: () => void) => void;
  onAct: (record: OutreachRecord, action: string, message: string) => void;
  onEdit: (text: string) => void;
}) {
  const open = drafting?.id === record.id;
  const since = record.days === 0 ? 'today' : `${record.days} ${record.days === 1 ? 'day' : 'days'} ago`;
  return (
    <>
      <p className="role">
        {record.person_name} <span className="sub">/ {record.company}</span> {record.due && <span className="tg red">Due</span>}
      </p>
      <p className="sub">
        {record.job_title && record.job_url ? (
          <a href={record.job_url} target="_blank" rel="noreferrer">
            {record.job_title}
          </a>
        ) : (
          'General outreach'
        )}{' '}
        / asked {shortDate(record.sent_at)} / last contact {since}
        {record.followups > 0 ? ` / followed up ${record.followups}x` : ''}
      </p>
      <div className="followup-actions">
        <button type="button" className="btn" aria-expanded={open} onClick={onDraft}>
          {open ? 'Close' : 'Follow up'}
        </button>
        <button type="button" className="btn" onClick={() => onAct(record, 'replied', `${record.person_name} marked as replied.`)}>
          Replied
        </button>
        <button type="button" className="btn" onClick={() => onAct(record, 'referred', `${record.person_name} marked as referred.`)}>
          Referred me
        </button>
        <button type="button" className="btn" onClick={() => onAct(record, 'dropped', `${record.person_name} dropped.`)}>
          Drop
        </button>
      </div>
      {open && drafting && (
        <div className="network-draft">
          <textarea rows={6} value={drafting.text} onChange={(e) => onEdit(e.target.value)} aria-label="Follow-up draft" />
          <div className="network-draft-actions">
            <button type="button" className="btn" onClick={() => onCopy(drafting.text)}>
              Copy draft
            </button>
            <button type="button" className="btn btn-dark" onClick={() => onCopy(drafting.text, () => window.open(linkedInPlace(record.person_name, record.company, record.person_url), '_blank', 'noopener'))}>
              Copy and open LinkedIn
            </button>
            <button type="button" className="btn" onClick={() => onAct(record, 'followed_up', `Follow-up recorded for ${record.person_name}.`)}>
              I followed up
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function DoneRow({ record }: { record: OutreachRecord }) {
  const label = record.status === 'replied' ? 'Replied' : record.status === 'referred' ? 'Referred me' : 'Dropped';
  return (
    <>
      <p className="role">
        {record.person_name} <span className="sub">/ {record.company}</span> <span className="tg">{label}</span>
      </p>
      <p className="sub">{record.job_title ?? 'General outreach'} / asked {shortDate(record.sent_at)}</p>
    </>
  );
}
