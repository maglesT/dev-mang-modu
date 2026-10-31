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
  const [user, setUser] = useState('');
  const load = async () => setRows(await api<AuditRow[]>('GET', `/api/audit${user ? `?user=${encodeURIComponent(user)}` : ''}`));
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <h1>Audit trail</h1>
      <form className="card row" onSubmit={(e) => { e.preventDefault(); void load(); }}>
        <input placeholder="User ID (optional)" value={user} onChange={(e) => setUser(e.target.value)} />
        <button type="submit">Show</button>
      </form>
      <table>
        <thead>
          <tr><th>When</th><th>Who</th><th>What</th><th>Record</th><th>Before</th><th>After</th><th>Reason</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{plantTime(r.at)}</td>
              <td>{r.actor ?? 'System'}</td>
              <td>{actionText(r.action)}</td>
              <td>{r.objectType} {r.objectId}</td>
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
