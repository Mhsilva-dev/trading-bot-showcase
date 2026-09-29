import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, makeCandles, bullishCrossCloses } from './helpers.js';
import { ErrorKind } from '../src/broker/errors.js';
import { Engine } from '../src/bot/Engine.js';
import { PAPER_ACCOUNT } from '../src/bot/accounts.js';

// Prepara um engine rodando com candles que geram BUY no próximo tick.
async function running(opts = {}) {
  const s = setup(opts);
  s.repo.setSettings('paper', { strategyParams: { rsiBuyMax: 90 }, min24hVolume: 0 });
  await s.engine.init();
  await s.engine.handleCommand({ command: 'start' });
  const closes = bullishCrossCloses();
  s.data.setPrice(closes.at(-1));
  s.data.book = { bids: [[closes.at(-1) - 5, 10]], asks: [[closes.at(-1) + 5, 10]] };
  s.data.candles = makeCandles(closes, s.now());
  return s;
}

const state = (s) => s.repo.getState('paper');

test('fluxo completo: sincroniza, recebe BUY, risco aprova, compra executada', async () => {
  const s = await running();
  await s.engine.tick();
  assert.equal(state(s).status, 'RUNNING', state(s).reason);
  const pos = s.repo.openPosition('paper', 'BTC-BRL');
  assert.ok(pos, JSON.stringify(s.events().map((e) => e.message)));
  assert.ok(s.events('RECONCILE_OK').length >= 1, 'reconciliou antes de operar');
  assert.equal(s.events('ORDER_FILLED').length, 1);
  assert.equal(s.repo.listSignals('paper')[0].signal, 'BUY');
});

test('stop-loss dispara venda quando o bid cai abaixo do stop', async () => {
  const s = await running();
  await s.engine.tick();
  const pos = s.repo.openPosition('paper', 'BTC-BRL');
  s.data.setPrice(pos.stop_price * 0.99);
  s.advance(61_000);
  await s.engine.tick();
  assert.equal(s.repo.openPosition('paper', 'BTC-BRL'), undefined);
  const t = s.repo.getTrade(pos.trade_id);
  assert.equal(t.exit_reason, 'STOP_LOSS');
  assert.ok(t.profit_loss < 0, 'trades perdedores aparecem como perda');
  assert.equal(s.events('STOP_LOSS').length, 1);
});

test('take-profit dispara venda', async () => {
  const s = await running();
  await s.engine.tick();
  const pos = s.repo.openPosition('paper', 'BTC-BRL');
  s.data.setPrice(pos.take_profit_price * 1.01);
  s.advance(61_000);
  await s.engine.tick();
  assert.equal(s.repo.getTrade(pos.trade_id).exit_reason, 'TAKE_PROFIT');
});

test('kill switch TRADING_ENABLED=false: sinal de compra não vira ordem', async () => {
  const s = await running({ env: { TRADING_ENABLED: 'false' } });
  await s.engine.tick();
  assert.equal(s.repo.openPosition('paper', 'BTC-BRL'), undefined);
  assert.equal(s.broker.calls.createOrder, undefined);
  assert.match(s.events('TRADE_BLOCKED')[0].message, /TRADING_ENABLED/);
});

test('EMERGENCY STOP gravado no banco vale imediatamente, mesmo sem comando processado', async () => {
  const s = await running();
  s.repo.setControl('paper', { emergency: true }, 'teste'); // painel grava direto
  await s.engine.tick();
  assert.equal(s.broker.calls.createOrder, undefined);
  assert.equal(state(s).status, 'EMERGENCY');
  await assert.rejects(s.engine.handleCommand({ command: 'start' }), /EMERGENCY/);
});

test('bot parado não abre posição', async () => {
  const s = await running();
  await s.engine.handleCommand({ command: 'stop' });
  await s.engine.tick();
  assert.equal(s.broker.calls.createOrder, undefined);
  assert.equal(state(s).status, 'STOPPED');
});

test('API caiu: não opera, entra em sincronização e volta só após reconciliar', async () => {
  const s = await running();
  s.broker.faults.getTicker = ErrorKind.NETWORK;
  await s.engine.tick();
  assert.equal(s.broker.calls.createOrder, undefined);
  assert.equal(state(s).status, 'SYNCING');
  assert.ok(s.events('BROKER_OFFLINE').length >= 1);
  delete s.broker.faults.getTicker;
  const recBefore = s.events('RECONCILE_OK').length;
  await s.engine.tick();
  assert.ok(s.events('RECONCILE_OK').length > recBefore, 'reconciliou após a queda');
  assert.equal(state(s).status, 'RUNNING');
});

test('erros consecutivos levam a FAIL SAFE, liberado só por sincronização manual', async () => {
  const s = await running();
  s.broker.faults.getBalance = ErrorKind.TIMEOUT;
  for (let i = 0; i < 5; i++) await s.engine.tick();
  assert.equal(state(s).status, 'FAIL_SAFE');
  delete s.broker.faults.getBalance;
  await s.engine.tick();
  assert.equal(state(s).status, 'FAIL_SAFE', 'não sai sozinho do fail safe');
  assert.equal(s.broker.calls.createOrder, undefined);
  await s.engine.handleCommand({ command: 'sync' });
  await s.engine.tick();
  assert.notEqual(state(s).status, 'FAIL_SAFE');
});

test('erro de autenticação -> FAIL SAFE', async () => {
  const s = await running();
  s.broker.faults.getBalance = ErrorKind.AUTH;
  await s.engine.tick();
  assert.equal(state(s).status, 'FAIL_SAFE');
});

test('resposta inválida não gera ordem', async () => {
  const s = await running();
  s.broker.faults.getTicker = async () => ({ bid: 0, ask: -1, last: 0, ts: Date.now() });
  await s.engine.tick();
  assert.equal(s.broker.calls.createOrder, undefined);
  assert.notEqual(state(s).status, 'RUNNING');
});

test('rate limit: não opera no ciclo e sincroniza depois', async () => {
  const s = await running();
  s.broker.faults.getOpenOrders = ErrorKind.RATE_LIMIT;
  await s.engine.tick();
  assert.equal(s.broker.calls.createOrder, undefined);
  delete s.broker.faults.getOpenOrders;
  await s.engine.tick();
  assert.ok(s.repo.openPosition('paper', 'BTC-BRL'));
});

test('timeout no envio da ordem: pausa, sincroniza e não duplica a compra', async () => {
  const s = await running();
  s.broker.faults.createOrder = 'PLACED_THEN_TIMEOUT';
  await s.engine.tick();
  assert.equal(s.events('ORDER_UNKNOWN').length, 1);
  assert.notEqual(state(s).status, 'RUNNING');
  delete s.broker.faults.createOrder;
  s.advance(1000);
  await s.engine.tick();
  const orders = s.repo.listOrders({ accountId: 'paper' }).rows;
  assert.equal(orders.length, 1, 'apenas uma ordem');
  assert.equal(orders[0].status, 'FILLED');
  const paperOrders = s.db.prepare('SELECT COUNT(*) n FROM paper_orders').get().n;
  assert.equal(paperOrders, 1, 'a corretora recebeu uma única ordem');
});

test('servidor reiniciou: novo engine não opera antes de reconciliar e reencontra a posição', async () => {
  const s = await running();
  await s.engine.tick();
  const pos = s.repo.openPosition('paper', 'BTC-BRL');
  assert.ok(pos);
  // "reinício": novo Engine sobre o mesmo banco
  const e2 = new Engine({ account: PAPER_ACCOUNT, broker: s.broker, repo: s.repo, db: s.db, config: s.config, log: s.log.child('paper'), now: s.now, orderPollDelayMs: 0 });
  assert.equal(e2.needsSync, true);
  const calls = s.broker.calls.createOrder;
  await e2.init();
  await e2.tick();
  assert.equal(s.broker.calls.createOrder, calls, 'não enviou nada novo');
  assert.equal(e2.needsSync, false);
  assert.equal(s.repo.openPosition('paper', 'BTC-BRL').id, pos.id);
});

test('reinício com divergência: TRADING PAUSED', async () => {
  const s = await running();
  await s.engine.tick();
  // alguém vendeu na corretora por fora
  const btc = (await s.paper.getBalance()).BTC.available;
  s.paper.addBalance('BTC', -btc);
  const e2 = new Engine({ account: PAPER_ACCOUNT, broker: s.broker, repo: s.repo, db: s.db, config: s.config, log: s.log.child('paper'), now: s.now, orderPollDelayMs: 0 });
  await e2.init();
  await e2.tick();
  assert.equal(s.repo.getState('paper').status, 'PAUSED');
  assert.match(s.repo.getState('paper').reason, /TRADING PAUSED/);
});

test('limite de perda diária: TRADING HALTED e nenhuma nova entrada', async () => {
  const s = await running({ env: { MAX_DAILY_LOSS: '0.5' } });
  await s.engine.tick();
  const pos = s.repo.openPosition('paper', 'BTC-BRL');
  s.data.setPrice(pos.stop_price * 0.9);
  s.advance(61_000);
  await s.engine.tick(); // stop-loss com perda > 0.5
  assert.ok(s.events('DAILY_LOSS_HALT').length >= 1);
  assert.equal(state(s).status, 'HALTED');
  // novo sinal de compra no mesmo dia -> bloqueado
  const closes = bullishCrossCloses().map((c) => c * 0.8);
  s.data.setPrice(closes.at(-1));
  s.advance(15 * 60_000);
  s.data.candles = makeCandles(closes, s.now());
  await s.engine.tick();
  assert.equal(s.repo.openPosition('paper', 'BTC-BRL'), undefined);
  assert.ok(s.events('TRADING_HALTED').length >= 1);
});

test('saldo insuficiente para o mínimo: NO TRADE registrado', async () => {
  const s = await running({ capital: 0.5 });
  await s.engine.tick();
  assert.equal(s.broker.calls.createOrder, undefined);
  assert.match(s.events('NO_TRADE')[0].message, /mínimo/);
});

test('banco indisponível: FAIL SAFE sem enviar ordens', async () => {
  const s = await running();
  s.db.close();
  await s.engine.tick();
  assert.equal(s.broker.calls.createOrder, undefined);
  assert.equal(s.engine.failSafe, 'Banco indisponível');
});

test('reset do paper exige bot parado e zera histórico', async () => {
  const s = await running();
  await s.engine.tick();
  await assert.rejects(s.engine.handleCommand({ command: 'reset_paper' }), /Pare o bot/);
  await s.engine.handleCommand({ command: 'stop' });
  await s.engine.handleCommand({ command: 'reset_paper', payload: { capital: 30 } });
  assert.equal(s.repo.listOrders({ accountId: 'paper' }).total, 0);
  assert.equal((await s.paper.getBalance()).BRL.available, 30);
});
