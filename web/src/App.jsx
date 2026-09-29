import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot, Gauge, ListOrdered, Layers, Wallet, Brain, ShieldCheck, ScrollText, FlaskConical, Briefcase, Settings, LogOut, Menu, Bell, Wifi, WifiOff, X, Plug, TrendingUp,
} from 'lucide-react';
import { api, setCsrf, setUnauthorizedHandler } from './services/api.js';
import { useRealtime } from './hooks/useRealtime.js';
import { BotContext } from './context.js';
import { Segmented, StatusPill, Toaster, toast } from './components/ui.jsx';
import { EmergencyButton } from './components/BotControls.jsx';
import { AlertsPanel } from './components/AlertsPanel.jsx';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Operations from './pages/Operations.jsx';
import Orders from './pages/Orders.jsx';
import Positions from './pages/Positions.jsx';
import MyStocks from './pages/MyStocks.jsx';
import Strategy from './pages/Strategy.jsx';
import Risk from './pages/Risk.jsx';
import Logs from './pages/Logs.jsx';
import Backtest from './pages/Backtest.jsx';
import Paper from './pages/Paper.jsx';
import SettingsPage from './pages/Settings.jsx';
import Connections from './pages/Connections.jsx';

const PAGES = [
  { id: 'overview', label: 'Visão geral', icon: Gauge, el: Overview, mobile: true },
  { id: 'mystocks', label: 'Minhas ações', icon: TrendingUp, el: MyStocks, mobile: true },
  { id: 'operations', label: 'Operações', icon: ListOrdered, el: Operations, mobile: true },
  { id: 'orders', label: 'Ordens', icon: Layers, el: Orders },
  { id: 'positions', label: 'Posições', icon: Wallet, el: Positions },
  { id: 'strategy', label: 'Estratégia', icon: Brain, el: Strategy },
  { id: 'risk', label: 'Risco', icon: ShieldCheck, el: Risk, mobile: true },
  { id: 'logs', label: 'Logs', icon: ScrollText, el: Logs, mobile: true },
  { id: 'backtest', label: 'Backtest', icon: FlaskConical, el: Backtest },
  { id: 'paper', label: 'Paper Trading', icon: Briefcase, el: Paper },
  { id: 'connections', label: 'Conexões', icon: Plug, el: Connections },
  { id: 'settings', label: 'Configurações', icon: Settings, el: SettingsPage },
];

const EVENT_TOASTS = {
  ORDER_FILLED: 'good', STOP_LOSS: 'warn', TAKE_PROFIT: 'good', TRADE_CLOSED: 'info', BROKER_OFFLINE: 'bad',
  RECONCILE_MISMATCH: 'bad', DAILY_LOSS_HALT: 'bad', BOT_STOPPED: 'warn', EMERGENCY_STOP: 'bad', FAIL_SAFE: 'bad', ORDER_UNKNOWN: 'bad',
};

function readHash() {
  const id = location.hash.replace('#/', '');
  return PAGES.some((p) => p.id === id) ? id : 'overview';
}

export default function App() {
  const [user, setUser] = useState(undefined);
  const [page, setPage] = useState(readHash);
  const [account, setAccount] = useState(() => { try { return localStorage.getItem('tb.account') || 'paper'; } catch { return 'paper'; } });
  const [moreOpen, setMoreOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const rt = useRealtime(!!user);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api.get('/api/auth/me').then((r) => { setCsrf(r.csrfToken); setUser(r.user); }).catch(() => setUser(null));
    const onHash = () => setPage(readHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => { try { localStorage.setItem('tb.account', account); } catch { /* sem storage */ } }, [account]);

  // Alertas visuais para eventos importantes em tempo real
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    const fresh = rt.events.filter((e) => e.id > seen);
    if (!fresh.length) return;
    setSeen(Math.max(...fresh.map((e) => e.id)));
    if (seen === 0) return; // não dispara para o histórico da conexão
    for (const e of fresh.slice(0, 3)) {
      if (EVENT_TOASTS[e.event] && (!e.account_id || e.account_id === account)) toast(`${e.account_id ? `[${e.account_id.toUpperCase()}] ` : ''}${e.message}`, EVENT_TOASTS[e.event]);
    }
  }, [rt.events]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((id) => { location.hash = `#/${id}`; setMoreOpen(false); window.scrollTo(0, 0); }, []);

  const status = rt.accounts.find((a) => a.account?.id === account) || null;
  const ctx = useMemo(() => ({ account, setAccount, status, tick: rt.tick, connected: rt.connected, events: rt.events, go, accounts: rt.accounts }), [account, status, rt.tick, rt.connected, rt.events, go, rt.accounts]);

  if (user === undefined) return <div className="flex h-full items-center justify-center text-ink-3">Carregando…</div>;
  if (!user) return <><Toaster /><Login onLogin={setUser} /></>;

  const Page = PAGES.find((p) => p.id === page).el;
  const logout = async () => { try { await api.post('/api/auth/logout'); } finally { setUser(null); } };

  return (
    <BotContext.Provider value={ctx}>
      <Toaster />
      <div className="min-h-full lg:flex">
        {/* Navegação lateral (desktop) */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
          <div className="flex items-center gap-2 px-5 py-5">
            <div className="rounded-lg bg-series-1/15 p-1.5 text-series-1"><Bot size={20} /></div>
            <span className="font-semibold">Trading Bot</span>
          </div>
          <nav className="flex-1 space-y-0.5 px-3">
            {PAGES.map((p) => (
              <button key={p.id} type="button" onClick={() => go(p.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${page === p.id ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink'}`}>
                <p.icon size={17} /> {p.label}
              </button>
            ))}
          </nav>
          <div className="border-t border-border p-3">
            <div className="mb-2 truncate px-2 text-xs text-ink-3">{user.username}</div>
            <button type="button" onClick={logout} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-2 hover:bg-surface-2"><LogOut size={17} /> Sair</button>
          </div>
        </aside>

        <div className="min-w-0 flex-1 pb-20 lg:pb-0">
          {/* Cabeçalho */}
          <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 lg:px-6">
              <div className="flex items-center gap-2 lg:hidden">
                <div className="rounded-lg bg-series-1/15 p-1.5 text-series-1"><Bot size={18} /></div>
              </div>
              <Segmented value={account} onChange={setAccount} options={[{ value: 'paper', label: 'PAPER' }, { value: 'xp', label: 'XP' }, { value: 'live', label: 'LIVE' }]} />
              {status && <StatusPill indicator={status.indicator} status={status.status} />}
              <span className={`hidden items-center gap-1 text-xs sm:inline-flex ${rt.connected ? 'text-ink-3' : 'text-warn'}`} title={rt.connected ? 'Tempo real conectado' : 'Tempo real desconectado — atualizando a cada 5s'}>
                {rt.connected ? <Wifi size={14} /> : <WifiOff size={14} />}{rt.connected ? 'tempo real' : 'polling'}
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={() => setAlertsOpen(true)} className="relative rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Alertas">
                  <Bell size={18} />
                  {status?.unreadAlerts > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-bad px-1 text-center text-[10px] font-bold text-white">{status.unreadAlerts > 99 ? '99+' : status.unreadAlerts}</span>}
                </button>
                <EmergencyButton compact />
              </div>
            </div>
            {status && status.status !== 'RUNNING' && status.reason && (
              <div className={`border-t border-border px-4 py-1.5 text-xs lg:px-6 ${['EMERGENCY', 'FAIL_SAFE', 'OFFLINE'].includes(status.status) ? 'bg-bad/10 text-bad' : 'bg-warn/10 text-warn'}`}>
                {status.reason}
              </div>
            )}
          </header>

          <main className="mx-auto max-w-7xl px-4 py-5 lg:px-6">
            <Page />
          </main>
        </div>

        {/* Navegação inferior (celular) */}
        <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
          {PAGES.filter((p) => p.mobile).map((p) => (
            <button key={p.id} type="button" onClick={() => go(p.id)} className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${page === p.id ? 'text-series-1' : 'text-ink-3'}`}>
              <p.icon size={20} />{p.label.split(' ')[0]}
            </button>
          ))}
          <button type="button" onClick={() => setMoreOpen(true)} className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] ${!PAGES.find((p) => p.id === page).mobile ? 'text-series-1' : 'text-ink-3'}`}>
            <Menu size={20} />Mais
          </button>
        </nav>

        {moreOpen && (
          <div className="fixed inset-0 z-50 bg-black/60 lg:hidden" onClick={() => setMoreOpen(false)}>
            <div className="fade-in absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between"><span className="text-sm font-semibold">Menu</span><button type="button" onClick={() => setMoreOpen(false)} aria-label="Fechar"><X size={18} /></button></div>
              <div className="grid grid-cols-3 gap-2">
                {PAGES.filter((p) => !p.mobile).map((p) => (
                  <button key={p.id} type="button" onClick={() => go(p.id)} className="flex flex-col items-center gap-1 rounded-xl border border-border bg-surface-2 p-3 text-xs text-ink-2"><p.icon size={20} />{p.label}</button>
                ))}
                <button type="button" onClick={logout} className="flex flex-col items-center gap-1 rounded-xl border border-border bg-surface-2 p-3 text-xs text-ink-2"><LogOut size={20} />Sair</button>
              </div>
            </div>
          </div>
        )}
        <AlertsPanel open={alertsOpen} onClose={() => setAlertsOpen(false)} />
      </div>
    </BotContext.Provider>
  );
}
