import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest, parseCandlesCsv } from '../src/backtest/Backtester.js';
import { bullishCrossCloses, makeCandles } from './helpers.js';

function series(extra) {
  const closes = [...bullishCrossCloses(), ...extra];
  return makeCandles(closes, Date.parse('2026-09-25T00:00:00Z'));
}

test('executa na abertura do candle seguinte ao sinal (sem olhar o futuro)', () => {
  const c = series([110_000, 110_000]);
  const r = runBacktest({ candles: c, strategyParams: { rsiBuyMax: 90 }, feePercent: 0, slippagePercent: 0 });
  const buy = r.markers.find((m) => m.side === 'BUY');
  assert.ok(buy, 'houve compra');
  const signalIdx = bullishCrossCloses().length - 1;
  assert.equal(buy.t, c[signalIdx + 1].t, 'compra no candle seguinte ao sinal');
  assert.equal(buy.price, c[signalIdx + 1].o);
});

test('take-profit fecha no alvo e contabiliza ganho com taxas', () => {
  const base = bullishCrossCloses();
  const last = base.at(-1);
  const c = series([last]);
  c.push({ t: c.at(-1).t + 900, o: last, h: last * 1.05, l: last * 0.999, c: last * 1.04, v: 1 });
  const r = runBacktest({ candles: c, strategyParams: { rsiBuyMax: 90 }, feePercent: 0.5, slippagePercent: 0, takeProfitPercent: 3 });
  const t = r.trades[0];
  assert.equal(t.reason, 'TAKE_PROFIT');
  assert.ok(Math.abs(t.exitPrice - t.entryPrice * 1.03) < 1e-6);
  assert.ok(t.profitLoss > 0 && t.fees > 0);
  assert.ok(Math.abs(r.summary.finalCapital - (20 + t.profitLoss)) < 1e-9);
});

test('gap acima do alvo executa na abertura (preço realista, não no alvo)', () => {
  const last = bullishCrossCloses().at(-1);
  const r = runBacktest({ candles: series([last, last * 1.05]), strategyParams: { rsiBuyMax: 90 }, feePercent: 0, slippagePercent: 0 });
  assert.equal(r.trades[0].reason, 'TAKE_PROFIT');
  assert.equal(r.trades[0].exitPrice, last * 1.05);
});

test('stop-loss tem prioridade quando stop e alvo são tocados no mesmo candle', () => {
  const base = bullishCrossCloses();
  const last = base.at(-1);
  const c = series([last]);
  c.push({ t: c.at(-1).t + 900, o: last, h: last * 1.2, l: last * 0.8, c: last, v: 1 });
  const r = runBacktest({ candles: c, strategyParams: { rsiBuyMax: 90 }, feePercent: 0, slippagePercent: 0 });
  assert.equal(r.trades[0].reason, 'STOP_LOSS');
  assert.ok(r.trades[0].profitLoss < 0);
  assert.equal(r.summary.losses, 1);
  assert.ok(r.summary.maxDrawdownPercent > 0);
});

test('não compra se o valor fica abaixo do mínimo da corretora', () => {
  const r = runBacktest({ candles: series([1, 1].map(() => 110_000)), strategyParams: { rsiBuyMax: 90 }, capital: 0.5, minCost: 0.9 });
  assert.equal(r.summary.trades, 0);
});

test('resultado inclui métricas e aviso', () => {
  const r = runBacktest({ candles: series([110_000]), strategyParams: { rsiBuyMax: 90 } });
  for (const k of ['initialCapital', 'finalCapital', 'profitLoss', 'profitLossPercent', 'trades', 'wins', 'losses', 'fees', 'maxDrawdownPercent', 'biggestWin', 'biggestLoss']) {
    assert.ok(k in r.summary, k);
  }
  assert.match(r.disclaimer, /não garantem/);
  assert.equal(r.equity.length > 0, true);
});

test('CSV: aceita datas ISO e timestamps, rejeita linhas inválidas', () => {
  const k = parseCandlesCsv('date,open,high,low,close,volume\n2026-01-02,10,11,9,10.5,100\n2026-01-01,9,10,8,9.5,50');
  assert.equal(k.length, 2);
  assert.ok(k[0].t < k[1].t);
  assert.equal(parseCandlesCsv('t;o;h;l;c\n1790000000000;1;1;1;1')[0].t, 1790000000);
  assert.throws(() => parseCandlesCsv('date,open,high,low,close\n2026-01-01,a,1,1,1'), /inválida/);
  assert.throws(() => parseCandlesCsv('x,y\n1,2'), /obrigatória/);
});
