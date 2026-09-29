import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { ErrorKind } from '../src/broker/errors.js';

test('paper: saldo inicial, compra com taxa no ativo e venda com taxa em reais', async () => {
  const { paper } = setup({ price: 100_000, capital: 20, fee: 0.5, slippage: 0 });
  await paper.init();
  assert.equal((await paper.getBalance()).BRL.available, 20);

  const buy = await paper.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, externalId: 'a1' });
  assert.equal(buy.status, 'FILLED');
  assert.equal(buy.avgPrice, 100_005); // ask
  const bal = await paper.getBalance();
  assert.ok(Math.abs(bal.BRL.available - (20 - buy.filledQty * 100_005)) < 1e-9);
  assert.ok(Math.abs(bal.BTC.available - buy.filledQty * 0.995) < 1e-12);

  const sell = await paper.createOrder({ symbol: 'BTC-BRL', side: 'SELL', qty: bal.BTC.available, externalId: 'a2' });
  assert.equal(sell.status, 'FILLED');
  assert.equal(sell.avgPrice, 99_995); // bid
  const after = await paper.getBalance();
  assert.ok(after.BRL.available < 20, 'taxas + spread fazem o ciclo perder dinheiro');
});

test('paper: recusa valor abaixo do mínimo, saldo insuficiente e externalId duplicado', async () => {
  const { paper } = setup({ capital: 20 });
  await paper.init();
  await assert.rejects(paper.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 0.5, externalId: 'x' }), (e) => e.kind === ErrorKind.REJECTED);
  await assert.rejects(paper.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 50, externalId: 'y' }), (e) => e.kind === ErrorKind.INSUFFICIENT_FUNDS);
  await assert.rejects(paper.createOrder({ symbol: 'BTC-BRL', side: 'SELL', qty: 0.001, externalId: 'z' }), (e) => e.kind === ErrorKind.INSUFFICIENT_FUNDS);
  await paper.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 5, externalId: 'dup' });
  await assert.rejects(paper.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 5, externalId: 'dup' }), /duplicado/);
});

test('paper: mercado fechado é recusado', async () => {
  const { paper, data } = setup();
  await paper.init();
  data.rules.tradable = false;
  paper.rulesCache.clear();
  await assert.rejects(paper.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 5, externalId: 'm' }), (e) => e.kind === ErrorKind.MARKET_CLOSED);
});

test('paper: estado persiste no banco (reinício) e reset volta ao capital', async () => {
  const { paper, db, data } = setup({ capital: 20 });
  await paper.init();
  await paper.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, externalId: 'p1' });
  const { PaperBroker } = await import('../src/paper/PaperBroker.js');
  const again = new PaperBroker({ db, accountId: 'paper', dataSource: data, initialCapital: 20 });
  await again.init(); // não pode resetar saldo existente
  const bal = await again.getBalance();
  assert.ok(bal.BTC.available > 0);
  assert.ok(await again.findOrderByExternalId('BTC-BRL', 'p1'));
  again.reset(50);
  assert.deepEqual(Object.keys(await again.getBalance()), ['BRL']);
  assert.equal((await again.getBalance()).BRL.available, 50);
});
