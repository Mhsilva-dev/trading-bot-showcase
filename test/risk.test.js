import test from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager, Decision } from '../src/bot/risk/RiskManager.js';
import { RULES } from './helpers.js';

const SETTINGS = {
  maxPositionPercent: 95, maxOrderValue: 20, maxDailyLoss: 1, maxDailyTrades: 4, stopLossPercent: 2,
  takeProfitPercent: 3, maxSpreadPercent: 0.5, min24hVolume: 1000, stopManageExits: true,
};

function ctx(over = {}) {
  const base = {
    account: { id: 'paper', mode: 'paper' },
    global: { tradingEnabled: true, liveBlockReason: 'TRADING_MODE não é live' },
    control: { desired: 'RUNNING', emergency: false },
    dbOk: true,
    engine: { needsSync: false, reconcileMismatch: null, failSafe: null },
    brokerHealth: { ok: true },
    localActiveOrders: [],
    brokerOpenOrders: [],
    market: {
      rules: RULES,
      ticker: { bid: 99_995, ask: 100_005, last: 100_000, quoteVolume: 1e7 },
      tickerAgeSec: 2,
      marketOpen: true,
      orderBook: { asks: [[100_005, 1]], bids: [[99_995, 1]] },
    },
    valuation: { cash: 20, cashAvailable: 20, baseQty: 0, baseAvailable: 0, positionValue: 0, equity: 20 },
    position: null,
    daily: { profit_loss: 0, trades: 0 },
    fees: { maker: 0.003, taker: 0.007 },
    settings: SETTINGS,
  };
  const merged = { ...base, ...over };
  if (over.market) merged.market = { ...base.market, ...over.market };
  if (over.settings) merged.settings = { ...SETTINGS, ...over.settings };
  return merged;
}

const rm = new RiskManager({ maxDataAgeSec: 90 });

test('aprova entrada quando tudo está seguro e calcula o valor', () => {
  const d = rm.evaluateEntry(ctx());
  assert.equal(d.decision, Decision.APPROVED, d.reasons.join());
  assert.equal(d.orderCost, 19); // 95% de 20
});

const blocked = [
  ['kill switch desligado', { global: { tradingEnabled: false } }, /TRADING_ENABLED/],
  ['live sem confirmação', { account: { id: 'live', mode: 'live' }, global: { tradingEnabled: true, liveBlockReason: 'LIVE_TRADING_CONFIRM=true não configurado' } }, /LIVE TRADING BLOCKED/],
  ['emergency stop', { control: { desired: 'RUNNING', emergency: true } }, /EMERGENCY/],
  ['bot pausado', { control: { desired: 'PAUSED', emergency: false } }, /não está em execução/],
  ['banco indisponível', { dbOk: false }, /Banco/],
  ['estado desconhecido', { engine: { needsSync: true } }, /desconhecido/],
  ['reconciliação divergente', { engine: { reconcileMismatch: 'x' } }, /Reconciliação/],
  ['fail safe', { engine: { failSafe: 'erro' } }, /FAIL SAFE/],
  ['API offline', { brokerHealth: { ok: false, message: 'TIMEOUT' } }, /API/],
  ['ordem local em andamento', { localActiveOrders: [{ id: 1 }] }, /em andamento/],
  ['ordens da corretora desconhecidas', { brokerOpenOrders: null }, /desconhecidas/],
  ['ordem aberta na corretora', { brokerOpenOrders: [{ id: 'x' }] }, /aberta/],
  ['preço desatualizado', { market: { tickerAgeSec: 500 } }, /desatualizado/],
  ['sem preço', { market: { ticker: null } }, /Preço atual desconhecido/],
  ['sem regras', { market: { rules: null } }, /Regras/],
  ['mercado fechado', { market: { marketOpen: false } }, /Mercado fechado/],
  ['saldo desconhecido', { valuation: null }, /Saldo desconhecido/],
];

for (const [name, over, re] of blocked) {
  test(`bloqueia entrada: ${name}`, () => {
    const d = rm.evaluateEntry(ctx(over));
    assert.equal(d.allowed, false);
    assert.equal(d.decision, Decision.TRADE_BLOCKED);
    assert.match(d.reasons.join(' | '), re);
  });
}

test('limite diário atingido -> TRADING_HALTED', () => {
  const d = rm.evaluateEntry(ctx({ daily: { profit_loss: -1.01, trades: 1 } }));
  assert.equal(d.decision, Decision.TRADING_HALTED);
});

test('máximo de operações no dia', () => {
  const d = rm.evaluateEntry(ctx({ daily: { profit_loss: 0, trades: 4 } }));
  assert.equal(d.allowed, false);
  assert.match(d.reasons[0], /Máximo/);
});

test('P/L diário desconhecido bloqueia', () => {
  assert.equal(rm.evaluateEntry(ctx({ daily: null })).allowed, false);
});

test('posição já aberta bloqueia nova entrada', () => {
  assert.match(rm.evaluateEntry(ctx({ position: { id: 1 } })).reasons[0], /posição aberta/);
});

test('saldo do ativo na corretora sem posição local bloqueia (estado incoerente)', () => {
  const d = rm.evaluateEntry(ctx({ valuation: { cash: 10, cashAvailable: 10, baseQty: 0.0001, equity: 20 } }));
  assert.match(d.reasons[0], /sincronizar/);
});

test('spread alto bloqueia', () => {
  const d = rm.evaluateEntry(ctx({ market: { ticker: { bid: 99_000, ask: 101_000, last: 100_000, quoteVolume: 1e7 } } }));
  assert.match(d.reasons[0], /Spread/);
});

test('liquidez 24h baixa bloqueia', () => {
  const d = rm.evaluateEntry(ctx({ settings: { min24hVolume: 1e9 } }));
  assert.match(d.reasons[0], /Liquidez/);
});

test('livro raso ou indisponível bloqueia', () => {
  assert.match(rm.evaluateEntry(ctx({ market: { orderBook: { asks: [[100_005, 0.0001]], bids: [] } } })).reasons[0], /Livro raso/);
  assert.match(rm.evaluateEntry(ctx({ market: { orderBook: null } })).reasons[0], /Livro/);
});

test('taxa desconhecida bloqueia', () => {
  assert.match(rm.evaluateEntry(ctx({ fees: null })).reasons[0], /Taxa/);
});

test('NO TRADE quando o saldo não alcança o mínimo da corretora', () => {
  const d = rm.evaluateEntry(ctx({ valuation: { cash: 0.5, cashAvailable: 0.5, baseQty: 0, equity: 0.5 } }));
  assert.equal(d.decision, Decision.NO_TRADE);
  assert.match(d.reasons[0], /mínimo/);
});

test('NO TRADE quando a quantidade fica abaixo do mínimo do ativo', () => {
  const d = rm.evaluateEntry(ctx({ market: { rules: { ...RULES, minVolume: 1 } } }));
  assert.equal(d.decision, Decision.NO_TRADE);
});

test('NO TRADE quando o take profit não cobre os custos', () => {
  const d = rm.evaluateEntry(ctx({ settings: { takeProfitPercent: 1 } }));
  assert.equal(d.decision, Decision.NO_TRADE);
  assert.match(d.reasons[0], /custos/);
});

test('respeita máximo por ordem', () => {
  const d = rm.evaluateEntry(ctx({ settings: { maxOrderValue: 5 } }));
  assert.equal(d.orderCost, 5);
});

test('saída permitida com bot parado se STOP_MANAGE_EXITS=true, bloqueada se false', () => {
  const c = ctx({ control: { desired: 'STOPPED', emergency: false } });
  assert.equal(rm.evaluateExit(c, { quantity: 0.0001 }).allowed, true);
  const c2 = ctx({ control: { desired: 'STOPPED', emergency: false }, settings: { stopManageExits: false } });
  assert.equal(rm.evaluateExit(c2, { quantity: 0.0001 }).allowed, false);
});

test('saída bloqueada em emergência e em estado desconhecido', () => {
  assert.equal(rm.evaluateExit(ctx({ control: { desired: 'RUNNING', emergency: true } }), { quantity: 0.0001 }).allowed, false);
  assert.equal(rm.evaluateExit(ctx({ engine: { needsSync: true } }), { quantity: 0.0001 }).allowed, false);
});

test('saída abaixo do mínimo -> NO_TRADE', () => {
  assert.equal(rm.evaluateExit(ctx(), { quantity: 0.0000001 }).decision, Decision.NO_TRADE);
});

test('status resume NORMAL / BLOCKED / HALTED', () => {
  assert.equal(rm.status(ctx()).status, 'NORMAL');
  assert.equal(rm.status(ctx({ dbOk: false })).status, 'BLOCKED');
  assert.equal(rm.status(ctx({ daily: { profit_loss: -5, trades: 0 } })).status, 'HALTED');
});
