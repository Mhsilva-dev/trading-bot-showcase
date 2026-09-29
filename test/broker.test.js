import test from 'node:test';
import assert from 'node:assert/strict';
import { MercadoBitcoinBroker } from '../src/broker/MercadoBitcoinBroker.js';
import { CircuitBreaker } from '../src/broker/http.js';
import { ErrorKind } from '../src/broker/errors.js';
import { redact, registerSecrets } from '../src/monitoring/logger.js';

function res(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), headers: { get: (k) => headers[k.toLowerCase()] } };
}

// fetch falso que roteia por "MÉTODO caminho"
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname.replace('/api/v4', '')}`;
    calls.push({ key, url: u, init });
    const h = routes[key];
    if (!h) return res(404, { message: 'rota não mockada ' + key });
    return typeof h === 'function' ? h(u, init, calls) : h;
  };
  fn.calls = calls;
  return fn;
}

const TOKEN = { access_token: 'tok-123', expires_in: 3599 };
const ORDER = { id: 'O1', instrument: 'BTC-BRL', side: 'buy', type: 'market', status: 'filled', qty: '0.0001', filledQty: '0.0001', avgPrice: 100000, fee: '0.0000007', externalId: 'ext-1', created_at: 1790000000, updated_at: 1790000001 };

function mb(routes, opts = {}) {
  const f = fakeFetch({ 'POST /oauth2/token': res(200, TOKEN), 'GET /accounts': res(200, [{ id: 'acc1' }]), ...routes });
  const b = new MercadoBitcoinBroker({ apiKey: 'client-id-xyz', apiSecret: 'super-secret-value', fetchImpl: f, baseDelayMs: 1, ...opts });
  return { b, f };
}

test('autentica com client_credentials e usa Bearer token', async () => {
  const { b, f } = mb({ 'GET /accounts/acc1/balances': res(200, [{ symbol: 'BRL', available: '20', on_hold: '0', total: '20' }]) });
  const bal = await b.getBalance();
  assert.equal(bal.BRL.available, 20);
  const auth = f.calls.find((c) => c.key === 'POST /oauth2/token');
  const form = new URLSearchParams(auth.init.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('scope'), 'global');
  const priv = f.calls.find((c) => c.key === 'GET /accounts/acc1/balances');
  assert.equal(priv.init.headers.Authorization, 'Bearer tok-123');
});

test('normaliza ordem: status, lado, taxa no ativo base na compra', async () => {
  const { b } = mb({ 'GET /accounts/acc1/BTC-BRL/orders/O1': res(200, ORDER) });
  const o = await b.getOrder('BTC-BRL', 'O1');
  assert.equal(o.status, 'FILLED');
  assert.equal(o.side, 'BUY');
  assert.equal(o.feeBase, 0.0000007);
  assert.equal(o.externalId, 'ext-1');
});

test('working com execução vira PARTIAL; status desconhecido é resposta inválida', async () => {
  const { b } = mb({});
  assert.equal(b.normalizeOrder({ ...ORDER, status: 'working', filledQty: '0.00005' }).status, 'PARTIAL');
  assert.throws(() => b.normalizeOrder({ ...ORDER, status: 'weird' }), (e) => e.kind === ErrorKind.INVALID_RESPONSE);
});

test('createOrder envia externalId, cost na compra e NÃO repete em erro 5xx', async () => {
  let posts = 0;
  const { b } = mb({ 'POST /accounts/acc1/BTC-BRL/orders': () => { posts += 1; return res(502, 'bad gateway'); } });
  await assert.rejects(b.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, externalId: 'ext-9' }), (e) => e.kind === ErrorKind.SERVER && e.unknownOutcome);
  assert.equal(posts, 1, 'sem retry na criação de ordem');
});

test('createOrder bem-sucedido consulta a ordem e devolve normalizada', async () => {
  let body;
  const { b } = mb({
    'POST /accounts/acc1/BTC-BRL/orders': (u, init) => { body = JSON.parse(init.body); return res(200, { orderId: 'O1' }); },
    'GET /accounts/acc1/BTC-BRL/orders/O1': res(200, ORDER),
  });
  const o = await b.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, externalId: 'ext-1' });
  assert.deepEqual(body, { side: 'buy', type: 'market', externalId: 'ext-1', async: false, cost: 10 });
  assert.equal(o.id, 'O1');
});

test('consultas repetem com backoff em timeout/5xx e respeitam o limite', async () => {
  let n = 0;
  const { b } = mb({ 'GET /tickers': () => { n += 1; return n < 3 ? res(503, 'x') : res(200, [{ pair: 'BTC-BRL', buy: '99', sell: '101', last: '100', high: '1', low: '1', vol: '5', date: 1790000000 }]); } });
  const t = await b.getTicker('BTC-BRL');
  assert.equal(n, 3);
  assert.equal(t.bid, 99);
  assert.equal(t.ask, 101);
});

test('retry é limitado: desiste depois de N tentativas', async () => {
  let n = 0;
  const { b } = mb({ 'GET /tickers': () => { n += 1; return res(500, 'x'); } });
  await assert.rejects(b.getTicker('BTC-BRL'), (e) => e.kind === ErrorKind.SERVER);
  assert.equal(n, 4); // 1 + 3 retries
});

test('rate limit (429) é classificado e respeita Retry-After', async () => {
  let n = 0;
  const { b } = mb({ 'GET /candles': () => { n += 1; return n === 1 ? res(429, 'slow', { 'retry-after': '0' }) : res(200, { t: [1], o: ['1'], h: ['1'], l: ['1'], c: ['1'], v: ['1'] }); } });
  const k = await b.getCandles('BTC-BRL', '15m', 1);
  assert.equal(k.length, 1);
  assert.equal(n, 2);
});

test('circuit breaker abre após falhas seguidas e recusa sem chamar a rede', async () => {
  let n = 0;
  const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
  const { b } = mb({ 'GET /tickers': () => { n += 1; return res(500, 'x'); } }, { breaker });
  await assert.rejects(b.getTicker('BTC-BRL'));
  const before = n;
  await assert.rejects(b.getTicker('BTC-BRL'), (e) => e.kind === ErrorKind.CIRCUIT_OPEN);
  assert.equal(n, before, 'não chamou a rede com o circuito aberto');
  assert.equal(b.health().ok, false);
});

test('circuit breaker: half-open fecha após sucesso', () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 100, now: () => t });
  cb.failure();
  assert.equal(cb.state, 'OPEN');
  t = 150;
  assert.equal(cb.state, 'HALF_OPEN');
  cb.success();
  assert.equal(cb.state, 'CLOSED');
});

test('resposta que não é JSON e campos numéricos inválidos -> INVALID_RESPONSE', async () => {
  const { b } = mb({ 'GET /tickers': res(200, '<html>manutenção</html>') });
  await assert.rejects(b.getTicker('BTC-BRL'), (e) => e.kind === ErrorKind.INVALID_RESPONSE);
  const { b: b2 } = mb({ 'GET /tickers': res(200, [{ pair: 'BTC-BRL', buy: 'abc', sell: '1', last: '1', high: '1', low: '1', vol: '1', date: 1 }]) });
  await assert.rejects(b2.getTicker('BTC-BRL'), (e) => e.kind === ErrorKind.INVALID_RESPONSE);
});

test('401 -> AUTH; saldo insuficiente é identificado', async () => {
  const { b } = mb({ 'POST /oauth2/token': res(401, { code: 'HUH401' }) });
  await assert.rejects(b.getBalance(), (e) => e.kind === ErrorKind.AUTH);
  const { b: b2 } = mb({ 'POST /accounts/acc1/BTC-BRL/orders': res(400, { code: 'X', message: 'insufficient balance' }) });
  await assert.rejects(b2.createOrder({ symbol: 'BTC-BRL', side: 'BUY', cost: 10, externalId: 'e' }), (e) => e.kind === ErrorKind.INSUFFICIENT_FUNDS);
});

test('sem credenciais não tenta chamar endpoints privados', async () => {
  const b = new MercadoBitcoinBroker({ fetchImpl: async () => { throw new Error('não devia chamar'); } });
  await assert.rejects(b.getBalance(), (e) => e.kind === ErrorKind.AUTH);
});

test('findOrderByExternalId procura pelo id do cliente', async () => {
  const { b } = mb({ 'GET /accounts/acc1/BTC-BRL/orders': res(200, [{ ...ORDER, externalId: 'outra' }, ORDER]) });
  assert.equal((await b.findOrderByExternalId('BTC-BRL', 'ext-1', 1790000000)).id, 'O1');
  assert.equal(await b.findOrderByExternalId('BTC-BRL', 'nada', 1790000000), null);
});

test('segredos nunca aparecem nos logs', () => {
  registerSecrets(['super-secret-value']);
  const out = redact({ msg: 'falhou com super-secret-value', api_secret: 'x', nested: { Authorization: 'Bearer abc.def' }, text: 'Bearer abc.def' });
  const s = JSON.stringify(out);
  assert.ok(!s.includes('super-secret-value'));
  assert.ok(!s.includes('abc.def'));
});
