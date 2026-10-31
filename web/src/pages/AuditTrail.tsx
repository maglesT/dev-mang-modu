import { useEffect, useState } from 'react';
import { api, plantTime, type AuditRow } from '../api.js';

// DV-15, CP-10: the audit trail for QA and Admin. Each record's own history comes with S2/S3.
const ACTION: Record<string, string> = {
  login: 'Logged in',
  logout: 'Logged out',
  'login.failed': 'Failed login',
  'password.changed': 'Password changed',
  'password.change_failed': 'Password change refused',
  'user.created': 'User created',
  'user.updated': 'User changed',
  'user.locked': 'Account locked (too many wrong passwords)',
  'user.password_reset': 'Temporary password issued',
  'alert.acknowledged': 'Security alert acknowledged',
};
const actionText = (a: string) => ACTION[a] ?? a.replaceAll(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const value = (v: unknown) => (v === null || v === undefined ? '' : JSON.stringify(v));

export function AuditTrail() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [f, setF] = useState({ user: '', from: '', to: '' });
  const load = async () => {
    const q = new URLSearchParams();
    if (f.user) q.set('user', f.user);
    // Dates are plant days (IST); "to" includes the whole day.
    if (f.from) q.set('from', `${f.from}T00:00:00+05:30`);
    if (f.to) q.set('to', new Date(new Date(`${f.to}T00:00:00+05:30`).getTime() + 86400_000).toISOString());
    setRows(await api<AuditRow[]>('GET', `/api/audit?${q}`));
  };
  const [integrity, setIntegrity] = useState<{ at: string; action: string; result: { problems: string[]; problemCount: number; signatures: number } } | null>(null);
  const loadIntegrity = async () => setIntegrity(await api('GET', '/api/integrity'));
  useEffect(() => {
    void load();
    void loadIntegrity();
  }, []);
  const runCheck = async () => {
    await api('POST', '/api/integrity/run');
    await loadIntegrity();
  };
  return (
    <>
      <h1>Audit trail</h1>
      {/* DV-22: the nightly integrity check, its last result and a manual run. */}
      <div className={`statusbar ${integrity && integrity.action === 'integrity.passed' ? 'fit' : 'blocked'}`}>
        <span>
          <b>Integrity check:</b>{' '}
          {integrity ? `${integrity.action === 'integrity.passed' ? 'passed' : `FAILED (${integrity.result.problemCount} problems)`} · ${plantTime(integrity.at)}` : 'not run yet'}
        </span>
        <button onClick={runCheck}>Run now</button>
        {integrity && integrity.action !== 'integrity.passed' && <ul>{integrity.result.problems.slice(0, 10).map((p) => <li key={p}>{p}</li>)}</ul>}
      </div>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <input placeholder="User ID (optional)" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} />
        <label>From <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label>To <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <button type="submit">Show</button>
      </form>
      {rows.length >= 1000 && <p className="notice">Showing the latest 1000 rows. Choose a shorter period to see older ones.</p>}
      <table>
        <thead>
          <tr><th>When</th><th>Who</th><th>What</th><th>Record</th><th>Before</th><th>After</th><th>Reason</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{plantTime(r.at)}</td>
              <td>{r.actor ? `${r.actor} (${r.actorUsername})` : 'System'}</td>
              <td>{actionText(r.action)}</td>
              <td>{r.objectType} {r.subject ?? r.objectId}</td>
              <td className="mono">{value(r.oldValue)}</td>
              <td className="mono">{value(r.newValue)}</td>
              <td>{r.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
