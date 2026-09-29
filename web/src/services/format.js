const TZ = 'America/Sao_Paulo';
const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function brl(v, { sign = false } = {}) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = brlFmt.format(v);
  return sign && v > 0 ? `+${s}` : s;
}

export function num(v, d = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function qty(v) {
  if (v === null || v === undefined) return '—';
  return Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 8 });
}

export function pct(v, { sign = false, d = 2 } = {}) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const s = `${num(v, d)}%`;
  return sign && v > 0 ? `+${s}` : s;
}

export function dateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function time(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', { timeZone: TZ });
}

export function shortDate(iso) {
  return new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 5) return 'agora';
  if (s < 60) return `há ${s}s`;
  if (s < 3600) return `há ${Math.floor(s / 60)}min`;
  return `há ${Math.floor(s / 3600)}h`;
}

export function tone(v) {
  if (v === null || v === undefined || v === 0) return 'text-ink-2';
  return v > 0 ? 'text-good' : 'text-bad';
}
