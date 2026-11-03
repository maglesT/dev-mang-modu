import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, can, type Me } from './api.js';
import { Login } from './pages/Login.js';
import { AuditTrail } from './pages/AuditTrail.js';
import { Home } from './pages/Home.js';
import { ReportForm } from './pages/ReportForm.js';
import { DeviationPage } from './pages/DeviationPage.js';
import { Admin } from './pages/Admin.js';
import { CapaList, CapaPage } from './pages/Capas.js';
import { BatchTrends } from './pages/BatchTrends.js';
import { Alerts } from './components/Alerts.js';

type Page = 'home' | 'report' | 'deviation' | 'capas' | 'capa' | 'batch' | 'admin' | 'audit';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('home');
  const [openId, setOpenId] = useState(0);

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
  if (me === null) return <Login />;

  const logout = async () => {
    const r = await api<{ logoutUrl: string | null }>('POST', '/api/logout');
    // The next person starts on Home, not on the previous user's page.
    setPage('home');
    setMe(null);
    // Ends the core session too (shared terminals).
    if (r.logoutUrl) window.location.assign(r.logoutUrl);
  };
  const open = (id: number) => {
    setOpenId(id);
    setPage('deviation');
  };
  const openCapa = (id: number) => {
    setOpenId(id);
    setPage('capa');
  };
  const tab = (p: Page, label: string) => (
    <button className={page === p ? 'tab on' : 'tab'} onClick={() => setPage(p)}>{label}</button>
  );
  // Holders of only the old Admin codes (settings, audit) start on the Admin page, as before (D-43).
  const isAdmin = can(me, 'deviations.settings.manage')
    && me.permissions.every((p) => p === 'deviations.audit.read' || p === 'deviations.settings.manage');

  return (
    <>
      <header className="bar">
        <span className="brand"><img src="/medhanta-mark.png" alt="Medhanta" /><span><b>Deviations &amp; CAPA</b><small>by Medhanta</small></span></span>
        <nav>
          {!isAdmin && tab('home', 'Deviations')}
          {!isAdmin && tab('capas', 'CAPAs')}
          {!isAdmin && tab('batch', 'Batch check & trends')}
          {can(me, 'deviations.audit.read') && tab('audit', 'Audit trail')}
          {can(me, 'deviations.settings.manage') && tab('admin', 'Admin')}
        </nav>
        <span className="who">
          {me.fullName}
          <button className="link" onClick={logout}>Log out</button>
        </span>
      </header>
      <main className="page">
        <Alerts me={me} />
        {page === 'home' && (isAdmin ? <Admin /> : <Home me={me} onReport={() => setPage('report')} onOpen={open} onCapas={() => setPage('capas')} />)}
        {page === 'report' && <ReportForm onDone={open} onCancel={() => setPage('home')} />}
        {page === 'deviation' && <DeviationPage key={openId} me={me} id={openId} onBack={() => setPage('home')} onOpenCapa={openCapa} onOpenDeviation={open} />}
        {page === 'capas' && <CapaList me={me} onOpen={openCapa} />}
        {page === 'batch' && <BatchTrends onOpen={open} />}
        {page === 'capa' && <CapaPage key={openId} me={me} id={openId} onBack={() => setPage('capas')} onOpenDeviation={open} onOpenCapa={openCapa} />}
        {page === 'admin' && <Admin />}
        {page === 'audit' && <AuditTrail />}
      </main>
    </>
  );
}
