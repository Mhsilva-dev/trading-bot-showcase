import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const nowIso = () => new Date().toISOString();

// Casas decimais de um passo vindo da corretora como string ("0.00000001").
// Number("0.00000001").toString() vira "1e-8", por isso tratamos a string.
export function stepDecimals(step) {
  const s = String(step);
  if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]);
  return (s.split('.')[1] || '').replace(/0+$/, '').length;
}

// Arredonda PARA BAIXO no múltiplo do passo — nunca vende/compra mais que o permitido.
export function floorToStep(value, step) {
  const st = Number(step);
  if (!st || st <= 0) return value;
  const d = stepDecimals(step);
  const units = Math.floor(value / st + 1e-9);
  return Number((units * st).toFixed(d));
}

export function round(value, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function pct(part, whole) {
  if (!whole) return 0;
  return (part / whole) * 100;
}

// "2026-09-25" no fuso configurado — usado para limites diários.
export function dayKey(date = new Date(), timeZone = 'America/Sao_Paulo') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function clientOrderId(accountId) {
  return `tb-${accountId}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export const TIMEFRAME_SECONDS = {
  '1m': 60, '15m': 900, '1h': 3600, '3h': 10800, '1d': 86400, '1w': 604800,
};

export function toNum(v, field) {
  const n = typeof v === 'number' ? v : Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) {
    const err = new Error(`Campo numérico inválido: ${field}=${JSON.stringify(v)}`);
    err.kind = 'INVALID_RESPONSE';
    throw err;
  }
  return n;
}
