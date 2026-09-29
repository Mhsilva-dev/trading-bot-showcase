import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { api } from '../services/api.js';
import { Badge, Empty, SEVERITY_TONE } from './ui.jsx';
import { dateTime } from '../services/format.js';

export function AlertsPanel({ open, onClose }) {
  const { account, tick } = useBot();
  const { data, reload } = useApi(open ? `/api/alerts?account=${account}` : null, tick, { enabled: open });

  useEffect(() => {
    if (open && data?.unread) api.post('/api/alerts/read', { account }).catch(() => {});
  }, [open, data?.unread, account]);
  useEffect(() => { if (open) reload(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/60" onClick={onClose}>
      <aside className="fade-in absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-border bg-surface" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-semibold">Alertas — {account.toUpperCase()}</h2>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-lg p-1.5 hover:bg-surface-2"><X size={18} /></button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {!data?.rows?.length ? <Empty>Nenhum alerta.</Empty> : data.rows.map((e) => (
            <div key={e.id} className={`border-b border-border px-4 py-3 ${e.alert_read ? '' : 'bg-surface-2/60'}`}>
              <div className="flex items-center gap-2 text-xs text-ink-3">
                <Badge tone={SEVERITY_TONE[e.severity]}>{e.severity}</Badge>
                <span>{e.event}</span>
                <span className="ml-auto">{dateTime(e.created_at)}</span>
              </div>
              <p className="mt-1 text-sm">{e.message}</p>
            </div>
          ))}
        </div>
        <footer className="border-t border-border px-4 py-2 text-xs text-ink-3">Integrações de notificação (Telegram, e-mail) podem ser conectadas no Logger do backend.</footer>
      </aside>
    </div>
  );
}
