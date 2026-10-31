import { useEffect, useState } from 'react';
import { api, plantTime, type Alert, type Me } from '../api.js';

// DV-18 / P11 11.300(d): misuse alerts stay on every screen for Admin and QA until acknowledged.
export function Alerts({ me }: { me: Me }) {
  const watches = me.roles.includes('admin') || me.roles.includes('qa');
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const load = async (background = false) => setAlerts(await api<Alert[]>('GET', '/api/alerts', undefined, background));
  useEffect(() => {
    if (!watches) return;
    void load();
    const timer = setInterval(() => void load(true).catch(() => window.location.reload()), 30_000);
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
            <strong>Security alert</strong> · {plantTime(a.createdAt)} · {a.message}
          </span>
          <button onClick={() => ack(a.id)}>Acknowledge</button>
        </div>
      ))}
    </>
  );
}
