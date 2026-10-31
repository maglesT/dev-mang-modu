import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api.js';
import { Login, ChangePassword } from './pages/Login.js';
import { Users } from './pages/Users.js';
import { AuditTrail } from './pages/AuditTrail.js';
import { Alerts } from './components/Alerts.js';

type Page = 'home' | 'users' | 'audit' | 'password';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('home');

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('GET', '/api/me'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else throw e;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (me === undefined) return <main className="page">Loading…</main>;
  if (me === null) return <Login onLoggedIn={refresh} />;
  if (me.passwordChangeRequired) return <ChangePassword me={me} forced onDone={refresh} />;

  const logout = async () => {
    await api('POST', '/api/logout');
    // The next person starts on Home, not on the previous user's page.
    setPage('home');
    setMe(null);
  };
  const tab = (p: Page, label: string) => (
    <button className={page === p ? 'tab on' : 'tab'} onClick={() => setPage(p)}>{label}</button>
  );

  return (
    <>
      <header className="bar">
        <span className="brand"><img src="/medhanta-mark.png" alt="Medhanta" /><span><b>Deviations &amp; CAPA</b><small>by Medhanta</small></span></span>
        <nav>
          {tab('home', 'Home')}
          {me.roles.some((r) => r === 'qa' || r === 'admin') && tab('audit', 'Audit trail')}
          {me.roles.includes('admin') && tab('users', 'Users')}
        </nav>
        <span className="who">
          {me.fullName}
          <button className="link" onClick={() => setPage('password')}>Change password</button>
          <button className="link" onClick={logout}>Log out</button>
        </span>
      </header>
      <main className="page">
        <Alerts me={me} />
        {page === 'home' && (
          <>
            <h1>Home</h1>
            <p className="greeting">Hello, {me.fullName}. Deviations and CAPAs arrive with the next slices.</p>
          </>
        )}
        {page === 'audit' && <AuditTrail />}
        {page === 'users' && <Users me={me} />}
        {page === 'password' && <ChangePassword me={me} onDone={() => setPage('home')} />}
      </main>
    </>
  );
}
