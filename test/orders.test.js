import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, RULES } from './helpers.js';
import { OrderManager, DuplicateGuardError } from '../src/bot/execution/OrderManager.js';
import { Portfolio } from '../src/bot/portfolio/Portfolio.js';
import { Reconciler } from '../src/bot/reconcile/Reconciler.js';
import { ErrorKind } from '../src/broker/errors.js';

const FILL = { strategy: 'ema_rsi', stopLossPercent: 2, takeProfitPercent: 3, rules: RULES };

function mk(env) {
  const s = setup(env);
  const log = s.log.child('paper');
  const portfolio = new Portfolio({ repo: s.repo, accountId: 'paper', log });
  const om = new OrderManager({ repo: s.repo, broker: s.broker, accountId: 'paper', portfolio, log, pollDelayMs: 0, notFoundGraceMs: 0 });
  const rec = new Reconciler({ repo: s.repo, broker: s.broker, orderManager: om, accountId: 'paper', log });
  return { ...s, portfolio, om, rec };
}

test('compra executada abre trade e posição com stop/take', async () => {
  const { om, paper, repo } = mk();
  await paper.init();
  const r = await om.submit({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, purpose: 'ENTRY', fillCtx: FILL });
  assert.equal(r.status, 'FILLED');
  const pos = repo.openPosition('paper', 'BTC-BRL');
  assert.ok(pos);
  assert.ok(Math.abs(pos.stop_price - pos.average_price * 0.98) < 1e-6);
  assert.ok(Math.abs(pos.take_profit_price - pos.average_price * 1.03) < 1e-6);
  assert.equal(repo.getTrade(pos.trade_id).status, 'OPEN');
});

test('venda fecha o trade e calcula P/L com taxas', async () => {
  const { om, paper, repo, data } = mk({ fee: 0.5 });
  await paper.init();
  await om.submit({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, purpose: 'ENTRY', fillCtx: FILL });
  const pos = repo.openPosition('paper', 'BTC-BRL');
  data.setPrice(110_000);
  const r = await om.submit({ symbol: 'BTC-BRL', side: 'SELL', qty: pos.quantity, purpose: 'TAKE_PROFIT', fillCtx: FILL });
  assert.equal(r.status, 'FILLED');
  const t = repo.getTrade(pos.trade_id);
  assert.equal(t.status, 'CLOSED');
  assert.equal(t.exit_reason, 'TAKE_PROFIT');
  const brl = (await paper.getBalance()).BRL.total;
  assert.ok(Math.abs(t.profit_loss - (brl - 20)) < 1e-6, `P/L ${t.profit_loss} deve bater com saldo ${brl - 20}`);
  assert.ok(t.fees > 0);
  assert.equal(repo.openPosition('paper', 'BTC-BRL'), undefined);
});

test('proteção contra duplicidade: ordem em andamento no banco impede nova ordem', async () => {
  const { om, paper, repo } = mk();
  await paper.init();
  repo.insertOrderIntent({ account_id: 'paper', client_order_id: 'pendente', symbol: 'BTC-BRL', side: 'BUY', type: 'market', cost: 5, purpose: 'ENTRY' });
  await assert.rejects(om.submit({ symbol: 'BTC-BRL', side: 'BUY', cost: 5, purpose: 'ENTRY', fillCtx: FILL }), DuplicateGuardError);
});

test('proteção contra duplicidade: ordem aberta na corretora impede nova ordem', async () => {
  const { om, paper, broker } = mk();
  await paper.init();
  broker.faults.getOpenOrders = async () => [{ id: 'x', status: 'OPEN' }];
  await assert.rejects(om.submit({ symbol: 'BTC-BRL', side: 'BUY', cost: 5, purpose: 'ENTRY', fillCtx: FILL }), DuplicateGuardError);
  assert.equal(broker.calls.createOrder, undefined);
});

test('timeout depois do envio -> UNKNOWN; reconciliação encontra a ordem pelo externalId', async () => {
  const { om, rec, paper, broker, repo, data } = mk();
  await paper.init();
  broker.faults.createOrder = 'PLACED_THEN_TIMEOUT';
  const r = await om.submit({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, purpose: 'ENTRY', fillCtx: FILL });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(repo.openPosition('paper', 'BTC-BRL'), undefined, 'sem confirmação, não assume posição');
  // nova ordem fica bloqueada enquanto houver UNKNOWN
  await assert.rejects(om.submit({ symbol: 'BTC-BRL', side: 'BUY', cost: 5, purpose: 'ENTRY', fillCtx: FILL }), DuplicateGuardError);
  delete broker.faults.createOrder;
  const res = await rec.run({ symbol: 'BTC-BRL', rules: RULES, ticker: await data.getTicker(), fillCtx: FILL });
  assert.equal(res.ok, true, res.mismatches.join());
  assert.equal(repo.getOrder(r.order.id).status, 'FILLED');
  assert.ok(repo.openPosition('paper', 'BTC-BRL'));
});

test('timeout antes de chegar na corretora -> UNKNOWN; reconciliação conclui que não existe', async () => {
  const { om, rec, paper, broker, repo, data } = mk();
  await paper.init();
  broker.faults.createOrder = ErrorKind.TIMEOUT;
  const r = await om.submit({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, purpose: 'ENTRY', fillCtx: FILL });
  assert.equal(r.status, 'UNKNOWN');
  delete broker.faults.createOrder;
  const res = await rec.run({ symbol: 'BTC-BRL', rules: RULES, ticker: await data.getTicker(), fillCtx: FILL });
  assert.equal(res.ok, true);
  assert.equal(repo.getOrder(r.order.id).status, 'REJECTED');
});

test('rejeição, saldo insuficiente e rate limit na criação -> REJECTED (não ambíguo)', async () => {
  for (const kind of [ErrorKind.REJECTED, ErrorKind.INSUFFICIENT_FUNDS, ErrorKind.RATE_LIMIT, ErrorKind.MARKET_CLOSED]) {
    const { om, paper, broker } = mk();
    await paper.init();
    broker.faults.createOrder = kind;
    const r = await om.submit({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, purpose: 'ENTRY', fillCtx: FILL });
    assert.equal(r.status, 'REJECTED', kind);
  }
});

test('execução parcial: aplica só o delta e é idempotente', async () => {
  const { om, paper, broker, repo } = mk();
  await paper.init();
  const base = { id: 'b1', symbol: 'BTC-BRL', side: 'BUY', type: 'market', feeQuote: 0 };
  let n = 0;
  broker.faults.createOrder = async ({ externalId }) => ({ ...base, externalId, status: 'PARTIAL', filledQty: 0.00005, avgPrice: 100_000, feeBase: 0 });
  broker.faults.getOrder = async () => {
    n += 1;
    return n === 1
      ? { ...base, status: 'PARTIAL', filledQty: 0.00005, avgPrice: 100_000, feeBase: 0 }
      : { ...base, status: 'FILLED', filledQty: 0.0001, avgPrice: 100_500, feeBase: 0 };
  };
  const r = await om.submit({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, purpose: 'ENTRY', fillCtx: FILL });
  assert.equal(r.status, 'FILLED');
  const pos = repo.openPosition('paper', 'BTC-BRL');
  assert.ok(Math.abs(pos.quantity - 0.0001) < 1e-12, `qtd ${pos.quantity}`);
  assert.ok(Math.abs(pos.average_price - 100_500) < 1e-6, `preço médio ${pos.average_price}`);
  // reaplicar a mesma ordem não duplica
  om.applyBrokerOrder(r.order, { ...base, externalId: r.order.client_order_id, status: 'FILLED', filledQty: 0.0001, avgPrice: 100_500, feeBase: 0 }, FILL);
  assert.ok(Math.abs(repo.openPosition('paper', 'BTC-BRL').quantity - 0.0001) < 1e-12);
});

test('reconciliação detecta ordem desconhecida na corretora e posição divergente', async () => {
  const { rec, paper, broker, data, repo } = mk();
  await paper.init();
  broker.faults.getOpenOrders = async () => [{ id: 'estranha', externalId: null, status: 'OPEN' }];
  let res = await rec.run({ symbol: 'BTC-BRL', rules: RULES, ticker: await data.getTicker(), fillCtx: FILL });
  assert.equal(res.ok, false);
  assert.match(res.mismatches.join(), /não é do bot/);

  delete broker.faults.getOpenOrders;
  // compra "por fora" do bot
  await paper.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, externalId: 'manual' });
  res = await rec.run({ symbol: 'BTC-BRL', rules: RULES, ticker: await data.getTicker(), fillCtx: FILL });
  assert.equal(res.ok, false);
  assert.match(res.mismatches.join(), /Posição divergente/);
  assert.ok(repo.listEvents({ accountId: 'paper' }).rows.some((e) => e.event === 'RECONCILE_MISMATCH'));
});

test('reconciliação ignora poeira abaixo do mínimo negociável', async () => {
  const { rec, paper, data } = mk();
  await paper.init();
  paper.addBalance('BTC', 0.000001); // < minVolume
  const res = await rec.run({ symbol: 'BTC-BRL', rules: RULES, ticker: await data.getTicker(), fillCtx: FILL });
  assert.equal(res.ok, true);
});
