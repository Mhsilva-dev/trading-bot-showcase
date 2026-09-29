import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../server/security.js';
import { runBacktest, parseCandlesCsv } from '../../backtest/Backtester.js';
import { STRATEGIES } from '../../bot/strategy/index.js';
import { TIMEFRAME_SECONDS } from '../../lib/util.js';

const Params = z.object({
  strategy: z.enum(Object.keys(STRATEGIES)).default('ema_rsi'),
  strategyParams: z.record(z.string().max(40), z.number().finite().min(0).max(1000)).default({}),
  capital: z.number().finite().positive().max(1e9).default(20),
  feePercent: z.number().finite().min(0).max(10).default(0.7),
  slippagePercent: z.number().finite().min(0).max(10).default(0.05),
  stopLossPercent: z.number().finite().min(0.1).max(90).default(2),
  takeProfitPercent: z.number().finite().min(0.1).max(1000).default(3),
  maxPositionPercent: z.number().finite().min(1).max(100).default(95),
  maxOrderValue: z.number().finite().positive().max(1e9).optional(),
});

const FromBroker = Params.extend({
  symbol: z.string().regex(/^[A-Z0-9]{2,12}-[A-Z]{3,5}$/).default('BTC-BRL'),
  timeframe: z.enum(Object.keys(TIMEFRAME_SECONDS)).default('15m'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const FromCsv = Params.extend({
  csv: z.string().min(10).max(5_000_000),
  label: z.string().max(40).default('CSV'),
});

const MAX_CANDLES = 20_000;

// Resultado enxuto para o painel (curvas reduzidas).
function slim(result) {
  const step = Math.max(1, Math.floor(result.equity.length / 800));
  return { ...result, equity: result.equity.filter((_, i) => i % step === 0 || i === result.equity.length - 1) };
}

export function backtestRoutes({ repo, marketData, log }) {
  const r = Router();
  let busy = false;

  const save = (params, result) => {
    repo.db.prepare('INSERT INTO backtests (params, summary) VALUES (?, ?)').run(JSON.stringify(params), JSON.stringify(result.summary));
  };

  r.post('/backtest', async (req, res, next) => {
    if (busy) return res.status(429).json({ error: 'Já existe um backtest em execução' });
    try {
      const p = validate(FromBroker, req.body);
      const from = Math.floor(Date.parse(`${p.from}T00:00:00Z`) / 1000);
      const to = Math.min(Math.floor(Date.parse(`${p.to}T23:59:59Z`) / 1000), Math.floor(Date.now() / 1000));
      if (!(to > from)) return res.status(400).json({ error: 'Período inválido' });
      const tf = TIMEFRAME_SECONDS[p.timeframe];
      if ((to - from) / tf > MAX_CANDLES) return res.status(400).json({ error: `Período longo demais para ${p.timeframe} (máx. ${MAX_CANDLES} candles)` });
      busy = true;
      const candles = await marketData.getCandlesRange(p.symbol, p.timeframe, from, to, tf);
      if (candles.length < 60) return res.status(400).json({ error: `Poucos candles no período (${candles.length})` });
      const result = runBacktest({ ...p, candles, maxOrderValue: p.maxOrderValue ?? Infinity });
      save({ ...p, source: 'mercadobitcoin' }, result);
      log.info('SYSTEM', 'BACKTEST', `Backtest ${p.symbol} ${p.timeframe} ${p.from}..${p.to}: P/L ${result.summary.profitLossPercent.toFixed(2)}% em ${result.summary.trades} trades`);
      res.json({ ...slim(result), candles: candles.length > 3000 ? undefined : candles });
    } catch (e) { next(e); } finally { busy = false; }
  });

  r.post('/backtest/csv', (req, res, next) => {
    try {
      const p = validate(FromCsv, req.body);
      const candles = parseCandlesCsv(p.csv);
      if (candles.length < 60) return res.status(400).json({ error: `Poucos candles no CSV (${candles.length})` });
      const { csv, ...params } = p;
      const result = runBacktest({ ...params, candles, maxOrderValue: p.maxOrderValue ?? Infinity });
      save({ ...params, source: 'csv' }, result);
      res.json({ ...slim(result), candles: candles.length > 3000 ? undefined : candles });
    } catch (e) {
      if (!e.status && /CSV|Coluna|Linha/.test(e.message)) e.status = 400;
      next(e);
    }
  });

  r.get('/backtest/history', (req, res) => {
    const rows = repo.db.prepare('SELECT * FROM backtests ORDER BY id DESC LIMIT 20').all()
      .map((b) => ({ id: b.id, created_at: b.created_at, params: JSON.parse(b.params), summary: JSON.parse(b.summary) }));
    res.json({ rows });
  });

  return r;
}
