import { useEffect, useState } from 'react';
import { api, ApiError, can, plantTime, type Alert, type Me } from '../api.js';

// DV-22: a failed integrity check stays on every screen for holders of deviations.audit.read until acknowledged.
// Misuse alerts (lockouts) are core's since D-43 (PL-04).
export function Alerts({ me }: { me: Me }) {
  const watches = can(me, 'deviations.audit.read');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const load = async (background = false) => setAlerts(await api<Alert[]>('GET', '/api/alerts', undefined, background));
  useEffect(() => {
    if (!watches) return;
    // A logged-out session (401) returns to the login screen; a passing network error waits for the next poll.
    const poll = (background: boolean) =>
      load(background).catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.reload();
      });
    void poll(false);
    const timer = setInterval(() => void poll(true), 30_000);
    return () => clearInterval(timer);
  }, [watches]);
  const ack = async (id: number) => {
    await api('POST', `/api/alerts/${id}/ack`);
    await load();
  };
  return (
    <>
      {alerts.map((a) => (
        <div key={a.id} className="alert" role="alert">
          <span>
            <strong>Integrity alert</strong> · {plantTime(a.createdAt)} · {a.message}
          </span>
          <button onClick={() => ack(a.id)}>Acknowledge</button>
        </div>
      ))}
    </>
  );
}
