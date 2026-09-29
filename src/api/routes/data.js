import { Router } from 'express';
import { z } from 'zod';
import { validate, toCsv } from '../../server/security.js';
import { ACCOUNT_IDS } from '../../bot/accounts.js';
import { effectiveSettings, SYMBOL_RE } from './bot.js';
import { createStrategy } from '../../bot/strategy/index.js';
import { dayKey } from '../../lib/util.js';

const acc = z.enum(ACCOUNT_IDS).default('paper');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/).optional();
const Page = z.object({
  account: acc,
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  symbol: z.string().regex(SYMBOL_RE).optional(),
  side: z.enum(['BUY', 'SELL']).optional(),
  result: z.enum(['WIN', 'LOSS']).optional(),
  status: z.enum(['PENDING_SUBMIT', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELED', 'REJECTED', 'UNKNOWN']).optional(),
  from: isoDate,
  to: isoDate,
});

// Datas sem hora: "até" inclui o dia inteiro.
const range = (q) => ({ from: q.from, to: q.to && q.to.length === 10 ? `${q.to}T23:59:59.999Z` : q.to });

const RANGES = { '1H': 3600, '6H': 21600, '1D': 86400, '7D': 604800, '30D': 2592000 };

function downsample(rows, max = 600) {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.floor(i * step)]);
  out.push(rows.at(-1));
  return out;
}

export function dataRoutes({ repo, config }) {
  const r = Router();
  const paged = (q) => ({ limit: q.pageSize, offset: (q.page - 1) * q.pageSize });

  r.get('/executions', (req, res) => {
    const q = validate(Page, req.query);
    const out = repo.listExecutions({ accountId: q.account, symbol: q.symbol, side: q.side, result: q.result, ...range(q), ...paged(q) });
    res.json({ ...out, page: q.page, pageSize: q.pageSize });
  });

  r.get('/trades', (req, res) => {
    const q = validate(Page, req.query);
    const out = repo.listTrades({ accountId: q.account, symbol: q.symbol, result: q.result, ...range(q), ...paged(q) });
    res.json({ ...out, page: q.page, pageSize: q.pageSize });
  });

  r.get('/orders', (req, res) => {
    const q = validate(Page, req.query);
    const out = repo.listOrders({ accountId: q.account, symbol: q.symbol, side: q.side, status: q.status, ...range(q), ...paged(q) });
    res.json({ ...out, page: q.page, pageSize: q.pageSize });
  });

  r.get('/positions', (req, res) => {
    const { account, history } = validate(z.object({ account: acc, history: z.enum(['0', '1']).default('0') }), req.query);
    const rows = repo.listPositions(account, history === '1').map((p) => {
      const t = p.trade_id ? repo.getTrade(p.trade_id) : null;
      const basis = t ? t.entry_cost * (p.quantity / t.quantity) : p.quantity * p.average_price;
      return { ...p, cost_basis: basis, unrealized_percent: basis ? (p.unrealized_profit / basis) * 100 : 0 };
    });
    res.json({ rows });
  });

  r.get('/signals', (req, res) => {
    const q = validate(z.object({ account: acc, signal: z.enum(['BUY', 'SELL', 'HOLD']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    res.json({ rows: repo.listSignals(q.account, { limit: q.limit, signal: q.signal }) });
  });

  const LogQ = z.object({
    account: acc,
    severity: z.string().regex(/^(INFO|WARNING|ERROR|TRADE|CRITICAL)(,(INFO|WARNING|ERROR|TRADE|CRITICAL))*$/).optional(),
    category: z.enum(['SYSTEM', 'BROKER', 'MARKET', 'STRATEGY', 'RISK', 'TRADE', 'ERROR', 'SECURITY']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(100),
    afterId: z.coerce.number().int().min(0).optional(),
  });
  r.get('/events', (req, res) => {
    const q = validate(LogQ, req.query);
    const out = repo.listEvents({ accountId: q.account, severity: q.severity?.split(','), category: q.category, afterId: q.afterId, limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    res.json({ ...out, page: q.page, pageSize: q.pageSize });
  });

  r.get('/alerts', (req, res) => {
    const { account } = validate(z.object({ account: acc }), req.query);
    res.json({ rows: repo.listEvents({ accountId: account, alertsOnly: true, limit: 50 }).rows, unread: repo.unreadAlerts(account) });
  });

  r.post('/alerts/read', (req, res) => {
    const { account } = validate(z.object({ account: acc }), req.body);
    repo.markAlertsRead(account);
    res.json({ ok: true });
  });

  r.get('/metrics', (req, res) => {
    const q = validate(z.object({ account: acc, from: isoDate, to: isoDate }), req.query);
    const s = repo.tradeStats(q.account);
    const today = dayKey(new Date(), config.timezone);
    const daily = repo.listDaily(q.account, q.from?.slice(0, 10), q.to?.slice(0, 10));
    const t = daily.find((d) => d.date === today);
    const firstSnap = repo.db.prepare('SELECT equity FROM equity_snapshots WHERE account_id = ? ORDER BY id LIMIT 1').get(q.account);
    const lastSnap = repo.lastEquitySnapshot(q.account);
    // drawdown máximo sobre a curva de patrimônio inteira
    let peak = 0; let maxDd = 0;
    for (const p of repo.db.prepare('SELECT equity FROM equity_snapshots WHERE account_id = ? ORDER BY id').iterate(q.account)) {
      peak = Math.max(peak, p.equity);
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - p.equity) / peak) * 100);
    }
    const buysToday = repo.db.prepare(`SELECT
        SUM(CASE WHEN side='BUY' THEN 1 ELSE 0 END) buys, SUM(CASE WHEN side='SELL' THEN 1 ELSE 0 END) sells
      FROM orders WHERE account_id = ? AND filled_quantity > 0 AND substr(updated_at,1,10) >= ?`).get(q.account, today);
    const base = firstSnap?.equity || null;
    res.json({
      totalTrades: s.closed || 0,
      openTrades: (s.total || 0) - (s.closed || 0),
      tradesToday: t?.trades ?? 0,
      buysToday: buysToday.buys || 0,
      sellsToday: buysToday.sells || 0,
      wins: s.wins || 0,
      losses: s.losses || 0,
      winRate: s.closed ? ((s.wins || 0) / s.closed) * 100 : 0,
      realizedPnL: s.realized || 0,
      pnlToday: t?.profit_loss ?? 0,
      totalPnLPercent: base && lastSnap ? ((lastSnap.equity - base) / base) * 100 : 0,
      initialEquity: base,
      fees: s.fees || 0,
      feesToday: t?.fees ?? 0,
      maxDrawdown: maxDd,
      drawdownToday: t?.drawdown ?? 0,
      biggestWin: s.best ?? 0,
      biggestLoss: s.worst ?? 0,
      daily,
      note: 'Métricas descritivas do histórico. Não indicam desempenho futuro.',
    });
  });

  r.get('/equity', (req, res) => {
    const q = validate(z.object({ account: acc, range: z.enum(['1H', '6H', '1D', '7D', '30D', 'ALL']).default('1D') }), req.query);
    const from = q.range === 'ALL' ? null : new Date(Date.now() - RANGES[q.range] * 1000).toISOString();
    res.json({ rows: downsample(repo.equitySeries(q.account, from, null)) });
  });

  // P/L acumulado realizado (trade a trade)
  r.get('/pnl', (req, res) => {
    const q = validate(z.object({ account: acc, from: isoDate, to: isoDate }), req.query);
    const { from, to } = range(q);
    const rows = repo.db.prepare(`SELECT closed_at, profit_loss, fees, id FROM trades WHERE account_id = ? AND status = 'CLOSED'
      AND closed_at >= ? AND closed_at <= ? ORDER BY closed_at`).all(q.account, from || '0000', to || '9999');
    let acc2 = 0;
    res.json({ rows: rows.map((t) => ({ ts: t.closed_at, pnl: t.profit_loss, cumulative: (acc2 += t.profit_loss), tradeId: t.id })) });
  });

  // Candles + indicadores da estratégia + pontos de compra/venda + stop/take
  r.get('/candles', (req, res) => {
    const q = validate(z.object({ account: acc, limit: z.coerce.number().int().min(20).max(1000).default(300) }), req.query);
    const s = effectiveSettings(repo, config, q.account);
    const candles = repo.getCandles(s.symbol, s.timeframe, q.limit);
    let indicators = {};
    try {
      const series = createStrategy(s.strategy, s.strategyParams).indicatorSeries(candles);
      indicators = Object.fromEntries(Object.entries(series).filter(([, v]) => v).map(([k, v]) => [k, v.map((val, i) => (val === null ? null : { t: candles[i].t, v: val })).filter(Boolean)]));
    } catch { /* sem indicadores */ }
    const since = candles[0] ? new Date(candles[0].t * 1000).toISOString() : '0000';
    const markers = repo.db.prepare(`SELECT id, side, avg_fill_price price, filled_quantity qty, purpose, updated_at FROM orders
      WHERE account_id = ? AND symbol = ? AND filled_quantity > 0 AND updated_at >= ? ORDER BY id`).all(q.account, s.symbol, since)
      .map((o) => ({ ...o, t: Math.floor(Date.parse(o.updated_at) / 1000) }));
    const position = repo.openPosition(q.account, s.symbol) || null;
    res.json({ symbol: s.symbol, timeframe: s.timeframe, candles, indicators, markers, position });
  });

  // ------------ exportação CSV ------------
  const EXPORTS = {
    trades: (a) => ({
      rows: repo.listTrades({ accountId: a, limit: 100000 }).rows,
      columns: ['id', 'symbol', 'side', 'entry_price', 'exit_price', 'quantity', 'entry_cost', 'fees', 'profit_loss', 'status', 'strategy', 'exit_reason', 'opened_at', 'closed_at'].map((key) => ({ key })),
    }),
    orders: (a) => ({
      rows: repo.listOrders({ accountId: a, limit: 100000 }).rows,
      columns: ['id', 'client_order_id', 'broker_order_id', 'symbol', 'side', 'type', 'quantity', 'cost', 'price', 'filled_quantity', 'avg_fill_price', 'fees', 'status', 'purpose', 'error', 'created_at', 'updated_at'].map((key) => ({ key })),
    }),
    history: (a) => ({
      rows: repo.listEvents({ accountId: a, limit: 100000 }).rows,
      columns: [{ key: 'id' }, { key: 'created_at' }, { key: 'severity' }, { key: 'category' }, { key: 'event' }, { key: 'message' }, { key: 'metadata', get: (e) => e.metadata }],
    }),
    metrics: (a) => ({
      rows: repo.listDaily(a),
      columns: ['date', 'starting_balance', 'ending_balance', 'profit_loss', 'fees', 'trades', 'wins', 'losses', 'drawdown'].map((key) => ({ key })),
    }),
  };

  r.get('/export/:type.csv', (req, res) => {
    const { type, account } = validate(z.object({ type: z.enum(Object.keys(EXPORTS)), account: acc }), { ...req.query, type: req.params.type });
    const { rows, columns } = EXPORTS[type](account);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-${account}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(`﻿${toCsv(rows, columns)}`);
  });

  return r;
}
