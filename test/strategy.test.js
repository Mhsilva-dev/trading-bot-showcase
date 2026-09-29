import test from 'node:test';
import assert from 'node:assert/strict';
import { ema, sma, rsi } from '../src/bot/strategy/indicators.js';
import { EmaRsiStrategy } from '../src/bot/strategy/EmaRsiStrategy.js';
import { createStrategy } from '../src/bot/strategy/index.js';
import { bullishCrossCloses, makeCandles } from './helpers.js';

test('SMA calcula média simples com null no aquecimento', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('EMA usa SMA como semente e k = 2/(n+1)', () => {
  const out = ema([1, 2, 3, 4, 5], 3);
  assert.equal(out[1], null);
  assert.equal(out[2], 2);           // SMA(1,2,3)
  assert.equal(out[3], 3);           // 4*0.5 + 2*0.5
  assert.equal(out[4], 4);           // 5*0.5 + 3*0.5
});

test('RSI: só altas = 100, só quedas = 0, lateral = 50', () => {
  const up = Array.from({ length: 20 }, (_, i) => i + 1);
  const down = [...up].reverse();
  assert.equal(rsi(up, 14).at(-1), 100);
  assert.equal(rsi(down, 14).at(-1), 0);
  assert.equal(rsi(Array(20).fill(5), 14).at(-1), 50);
});

test('RSI confere com valor de referência (Wilder)', () => {
  // Série clássica do livro de Wilder / StockCharts
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  assert.ok(Math.abs(rsi(closes, 14).at(-1) - 70.53) < 0.1);
});

test('estratégia retorna HOLD com dados insuficientes', () => {
  const s = new EmaRsiStrategy();
  const r = s.evaluate(makeCandles([1, 2, 3]));
  assert.equal(r.signal, 'HOLD');
  assert.match(r.reason, /insuficientes/);
});

test('estratégia gera BUY no cruzamento de alta', () => {
  const s = new EmaRsiStrategy({ rsiBuyMax: 90 });
  const r = s.evaluate(makeCandles(bullishCrossCloses()), { hasPosition: false });
  assert.equal(r.signal, 'BUY', r.reason);
  assert.ok(r.confidence > 0 && r.confidence <= 1);
  assert.ok(r.price > 0);
});

test('estratégia não compra com RSI acima do limite', () => {
  const s = new EmaRsiStrategy({ rsiBuyMax: 1 });
  const r = s.evaluate(makeCandles(bullishCrossCloses()), { hasPosition: false });
  assert.equal(r.signal, 'HOLD');
  assert.match(r.reason, /RSI/);
});

test('estratégia não compra abaixo da EMA de tendência', () => {
  const s = new EmaRsiStrategy({ rsiBuyMax: 90, trendPeriod: 80 });
  const closes = bullishCrossCloses();
  // derruba o início da série para a EMA80 ficar acima do preço
  const shifted = closes.map((c, i) => (i < 40 ? c + 20_000 : c));
  const r = s.evaluate(makeCandles(shifted), { hasPosition: false });
  assert.notEqual(r.signal, 'BUY');
});

test('com posição, cruzamento de baixa gera SELL', () => {
  const s = new EmaRsiStrategy({ rsiExit: 101 });
  const closes = bullishCrossCloses().map((c) => 300_000 - c); // espelha a série -> cruzamento de baixa
  const r = s.evaluate(makeCandles(closes), { hasPosition: true });
  assert.equal(r.signal, 'SELL', r.reason);
});

test('com signalExit = 0, cruzamento de baixa não gera SELL (saída só por stop/alvo)', () => {
  const s = new EmaRsiStrategy({ rsiExit: 101, signalExit: 0 });
  const closes = bullishCrossCloses().map((c) => 300_000 - c);
  const r = s.evaluate(makeCandles(closes), { hasPosition: true });
  assert.equal(r.signal, 'HOLD', r.reason);
});

test('com signalExit = 0 a estratégia continua comprando no cruzamento de alta', () => {
  const r = new EmaRsiStrategy({ signalExit: 0 }).evaluate(makeCandles(bullishCrossCloses()), { hasPosition: false });
  assert.equal(r.signal, new EmaRsiStrategy().evaluate(makeCandles(bullishCrossCloses()), { hasPosition: false }).signal);
});

test('signalExit só aceita 0 ou 1', () => {
  assert.throws(() => new EmaRsiStrategy({ signalExit: 2 }));
});

test('parâmetros inválidos são recusados e estratégia desconhecida falha', () => {
  assert.throws(() => new EmaRsiStrategy({ fastPeriod: 30, slowPeriod: 10 }));
  assert.throws(() => createStrategy('nao_existe'));
});
