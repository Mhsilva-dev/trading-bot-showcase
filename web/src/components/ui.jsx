import { useEffect, useState } from 'react';
import { X, TriangleAlert, Check, Info, CircleAlert } from 'lucide-react';

export function Card({ title, action, children, className = '', pad = true }) {
  return (
    <section className={`min-w-0 rounded-xl border border-border bg-surface ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {action}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint, valueClass = 'text-ink', icon: Icon }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
        {Icon && <Icon size={14} aria-hidden />}
        {label}
      </div>
      <div className={`tabular mt-1 text-xl font-semibold ${valueClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

const BADGE = {
  good: 'bg-good/15 text-good border-good/30',
  warn: 'bg-warn/15 text-warn border-warn/30',
  bad: 'bg-bad/15 text-bad border-bad/30',
  info: 'bg-series-1/15 text-series-1 border-series-1/30',
  muted: 'bg-surface-2 text-ink-2 border-border',
};

export function Badge({ tone = 'muted', children, className = '' }) {
  return <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium ${BADGE[tone]} ${className}`}>{children}</span>;
}

export function sideBadge(side) {
  return side === 'BUY' ? <Badge tone="good">BUY</Badge> : side === 'SELL' ? <Badge tone="bad">SELL</Badge> : <Badge>{side || 'HOLD'}</Badge>;
}

export const ORDER_TONE = { FILLED: 'good', OPEN: 'info', PARTIAL: 'warn', CANCELED: 'muted', REJECTED: 'bad', UNKNOWN: 'bad', PENDING_SUBMIT: 'warn' };
export const SEVERITY_TONE = { INFO: 'muted', WARNING: 'warn', ERROR: 'bad', CRITICAL: 'bad', TRADE: 'info' };

// Status do bot: 🟢 ONLINE / 🟡 PAUSED / 🔴 OFFLINE (cor + texto + ponto)
export function StatusPill({ indicator, status }) {
  const map = {
    ONLINE: { dot: 'bg-good', text: 'text-good', label: 'ONLINE' },
    PAUSED: { dot: 'bg-warn', text: 'text-warn', label: 'PAUSED' },
    OFFLINE: { dot: 'bg-bad', text: 'text-bad', label: 'OFFLINE' },
  };
  const m = map[indicator] || map.OFFLINE;
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs font-semibold ${m.text}`} title={status}>
      <span className={`h-2 w-2 rounded-full ${m.dot} ${indicator === 'ONLINE' ? 'pulse-dot' : ''}`} />
      {m.label}
      {status && status !== m.label && status !== 'RUNNING' && <span className="font-normal text-ink-3">· {status}</span>}
    </span>
  );
}

export function Button({ children, variant = 'default', className = '', ...p }) {
  const v = {
    default: 'border-border bg-surface-2 text-ink hover:bg-border',
    primary: 'border-series-1/50 bg-series-1 text-white hover:brightness-110',
    good: 'border-good/40 bg-good/15 text-good hover:bg-good/25',
    warn: 'border-warn/40 bg-warn/10 text-warn hover:bg-warn/20',
    danger: 'border-bad/50 bg-bad text-white hover:brightness-110',
    ghost: 'border-transparent text-ink-2 hover:bg-surface-2',
  }[variant];
  return (
    <button type="button" className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${v} ${className}`} {...p}>
      {children}
    </button>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full min-h-10 rounded-lg border border-border bg-bg px-3 text-sm text-ink outline-none focus:border-series-1';

export function Select({ value, onChange, options, className = '' }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} ${className}`}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Segmented({ value, onChange, options, size = 'sm' }) {
  return (
    <div className="inline-flex rounded-lg border border-border bg-bg p-0.5" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 ${size === 'sm' ? 'py-1 text-xs' : 'py-1.5 text-sm'} font-semibold transition ${value === o.value ? 'bg-surface-2 text-ink shadow' : 'text-ink-3 hover:text-ink-2'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ children = 'Nada por aqui ainda.' }) {
  return <div className="py-8 text-center text-sm text-ink-3">{children}</div>;
}

export function ErrorBox({ children }) {
  if (!children) return null;
  return <div className="flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/10 p-3 text-sm text-bad"><CircleAlert size={16} className="mt-0.5 shrink-0" />{children}</div>;
}

// Tabela responsiva: rola na horizontal dentro do card, nunca a página.
export function Table({ columns, rows, empty, rowKey = (r) => r.id }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-ink-3">
            {columns.map((c) => <th key={c.key} className={`px-3 py-2 font-medium ${c.right ? 'text-right' : ''}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-b border-border/60 last:border-0 hover:bg-surface-2/60">
              {columns.map((c) => <td key={c.key} className={`tabular px-3 py-2 ${c.right ? 'text-right' : ''} ${c.className || ''}`}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil((total || 0) / pageSize));
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-ink-3">
      <span>{total || 0} registro(s)</span>
      <div className="flex items-center gap-2">
        <Button variant="ghost" className="min-h-8 px-2" disabled={page <= 1} onClick={() => onPage(page - 1)}>Anterior</Button>
        <span className="tabular">{page} / {pages}</span>
        <Button variant="ghost" className="min-h-8 px-2" disabled={page >= pages} onClick={() => onPage(page + 1)}>Próxima</Button>
      </div>
    </div>
  );
}

// Diálogo de confirmação para ações importantes.
export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirmar', danger, onConfirm, onCancel, children }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const k = (e) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onCancel]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={onCancel}>
      <div role="dialog" aria-modal="true" className="fade-in w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className={`rounded-full p-2 ${danger ? 'bg-bad/15 text-bad' : 'bg-warn/15 text-warn'}`}><TriangleAlert size={20} /></div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-1 text-sm text-ink-2">{message}</p>
            {children}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancelar</Button>
          <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

// Toasts de feedback
let pushToast = () => {};
export function toast(message, tone = 'info') { pushToast({ message, tone, id: Math.random() }); }

export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    pushToast = (t) => {
      setItems((l) => [...l, t]);
      setTimeout(() => setItems((l) => l.filter((x) => x.id !== t.id)), 5000);
    };
  }, []);
  const icon = { good: Check, bad: CircleAlert, warn: TriangleAlert, info: Info };
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
      {items.map((t) => {
        const I = icon[t.tone] || Info;
        return (
          <div key={t.id} className={`fade-in pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg border bg-surface-2 p-3 text-sm shadow-xl ${BADGE[t.tone] || BADGE.info}`}>
            <I size={16} className="mt-0.5 shrink-0" />
            <span className="flex-1 text-ink">{t.message}</span>
            <button type="button" aria-label="Fechar" onClick={() => setItems((l) => l.filter((x) => x.id !== t.id))}><X size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}
