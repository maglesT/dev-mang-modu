import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type NamedItem, type Settings } from '../api.js';

const ask = (what: string) => window.prompt(`Reason for ${what} (e.g. change control number):`)?.trim();

// Admin: site name, target closure days (D-10) and the two short lists (D-12). Every change is audited (CP-07).
export function Admin() {
  const [s, setS] = useState<Settings | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    void api<Settings>('GET', '/api/settings').then(setS);
  }, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const reason = ask('changing the settings');
    if (!reason || !s) return;
    await api('PUT', '/api/settings', { ...s, reason });
    setNotice('Settings saved.');
  };
  if (!s) return <p>Loading…</p>;
  const num = (k: keyof Settings) => (e: { target: { value: string } }) => setS({ ...s, [k]: Number(e.target.value) });
  return (
    <>
      <h1>Admin</h1>
      {notice && <p className="notice">{notice}</p>}
      <form className="card" onSubmit={save}>
        <h2>Site and target dates</h2>
        <label>Site name<input value={s.siteName} onChange={(e) => setS({ ...s, siteName: e.target.value })} /></label>
        <div className="grid3">
          <label>Minor: days to close<input type="number" min={1} max={365} value={s.targetDaysMinor} onChange={num('targetDaysMinor')} /></label>
          <label>Major: days to close<input type="number" min={1} max={365} value={s.targetDaysMajor} onChange={num('targetDaysMajor')} /></label>
          <label>Critical: days to close<input type="number" min={1} max={365} value={s.targetDaysCritical} onChange={num('targetDaysCritical')} /></label>
        </div>
        <div className="actions"><button className="primary" type="submit">Save settings</button></div>
      </form>
      <List title="Areas" path="areas" />
      <List title="Deviation types" path="deviation-types" />
    </>
  );
}

function List({ title, path }: { title: string; path: string }) {
  const [items, setItems] = useState<NamedItem[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const load = async () => setItems(await api<NamedItem[]>('GET', `/api/${path}`));
  useEffect(() => {
    void load();
  }, []);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('POST', `/api/${path}`, { name });
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'name_taken' ? 'That name exists already.' : 'Could not add it.');
    }
  };
  // S14 (D-36): a lab / OOS type makes its investigations use the KT checklist.
  const toggleLab = async (i: NamedItem & { labOos?: boolean }) => {
    const reason = ask(`${i.labOos ? 'unmarking' : 'marking'} ${i.name} as a lab / OOS type`);
    if (!reason) return;
    await api('PATCH', `/api/deviation-types/${i.id}/lab`, { labOos: !i.labOos, reason });
    await load();
  };
  const toggle = async (i: NamedItem) => {
    const reason = ask(`${i.active ? 'deactivating' : 'reactivating'} ${i.name}`);
    if (!reason) return;
    await api('PATCH', `/api/${path}/${i.id}`, { active: !i.active, reason });
    await load();
  };
  return (
    <section className="card">
      <h2>{title}</h2>
      <form className="row" onSubmit={add}>
        <input aria-label={`New ${title.toLowerCase()}`} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="plain">
        {items.map((i) => (
          <li key={i.id}>
            {i.active ? i.name : <s>{i.name}</s>} <button className="link" onClick={() => toggle(i)}>{i.active ? 'Deactivate' : 'Reactivate'}</button>
            {path === 'deviation-types' && <>
              {(i as NamedItem & { labOos?: boolean }).labOos && <span className="chip chip-info">lab / OOS: KT checklist</span>}
              <button className="link" onClick={() => toggleLab(i)}>{(i as NamedItem & { labOos?: boolean }).labOos ? 'Not a lab type' : 'Mark as lab / OOS'}</button>
            </>}
          </li>
        ))}
      </ul>
    </section>
  );
}
