import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import WebSocket from 'ws';
import { setup } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { attachRealtime } from '../src/server/realtime.js';

async function server() {
  const s = setup();
  s.config.dashboard.sessionSecret = 'x'.repeat(40);
  s.repo.upsertUser('admin', bcrypt.hashSync('senha-muito-segura', 4));
  const { app, sessionMiddleware } = createApp({ db: s.db, repo: s.repo, config: s.config, log: s.log, marketData: null, staticDir: '/nao-existe' });
  const srv = http.createServer(app);
  const rt = attachRealtime({ server: srv, sessionMiddleware, repo: s.repo, config: s.config, log: s.log, intervalMs: 50 });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = '';
  let csrf = '';
  const req = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  const login = async () => {
    const r = await req('POST', '/api/auth/login', { username: 'admin', password: 'senha-muito-segura' });
    csrf = r.data.csrfToken;
    return r;
  };
  return {
    ...s, base, req, login,
    get cookie() { return cookie; },
    setCsrf(v) { csrf = v; },
    close: () => new Promise((r) => { rt.close(); srv.close(r); }),
  };
}

test('health é público e não expõe segredos', async () => {
  const t = await server();
  const r = await t.req('GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ['bot', 'broker', 'database', 'status', 'trading']);
  assert.equal(r.data.database, 'connected');
  assert.ok(r.headers.get('content-security-policy'));
  assert.equal(r.headers.get('x-powered-by'), null);
  await t.close();
});

test('rotas exigem login', async () => {
  const t = await server();
  for (const p of ['/api/bot/status', '/api/trades', '/api/settings', '/api/events']) {
    assert.equal((await t.req('GET', p)).status, 401, p);
  }
  await t.close();
});

test('login com senha errada falha; certo cria sessão com cookie seguro', async () => {
  const t = await server();
  assert.equal((await t.req('POST', '/api/auth/login', { username: 'admin', password: 'errada' })).status, 401);
  assert.equal((await t.req('POST', '/api/auth/login', { username: 'ninguem', password: 'x' })).status, 401);
  const r = await t.login();
  assert.equal(r.status, 200);
  assert.ok(r.data.csrfToken);
  assert.match(t.cookie, /^tb\.sid=/);
  const me = await t.req('GET', '/api/auth/me');
  assert.equal(me.data.user.username, 'admin');
  await t.close();
});

test('login rejeita Origin de outro site e entrada inválida', async () => {
  const t = await server();
  assert.equal((await t.req('POST', '/api/auth/login', { username: 'admin', password: 'senha-muito-segura' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await t.req('POST', '/api/auth/login', { username: '', password: 1 })).status, 400);
  await t.close();
});

test('CSRF: mutação sem token válido é recusada', async () => {
  const t = await server();
  await t.login();
  t.setCsrf('');
  assert.equal((await t.req('POST', '/api/bot/command', { account: 'paper', command: 'pause' })).status, 403);
  t.setCsrf('a'.repeat(64));
  assert.equal((await t.req('POST', '/api/bot/command', { account: 'paper', command: 'pause' })).status, 403);
  await t.close();
});

test('status do bot devolve campos do painel e OFFLINE sem heartbeat', async () => {
  const t = await server();
  await t.login();
  const r = await t.req('GET', '/api/bot/status?account=paper');
  assert.equal(r.status, 200);
  for (const k of ['status', 'mode', 'balance', 'equity', 'position', 'dailyPnL', 'totalPnL', 'lastSignal', 'lastTrade', 'riskStatus']) assert.ok(k in r.data, k);
  assert.equal(r.data.status, 'OFFLINE');
  assert.equal(JSON.stringify(r.data).includes('API_SECRET'), false);
  await t.close();
});

test('EMERGENCY STOP exige confirmação e grava o controle na hora', async () => {
  const t = await server();
  await t.login();
  const r1 = await t.req('POST', '/api/bot/command', { account: 'paper', command: 'emergency_stop' });
  assert.equal(r1.status, 400);
  assert.equal(r1.data.needsConfirm, true);
  const r2 = await t.req('POST', '/api/bot/command', { account: 'paper', command: 'emergency_stop', confirm: true });
  assert.equal(r2.status, 200);
  assert.equal(t.repo.getControl('paper').emergency, true);
  assert.ok(t.events('EMERGENCY_STOP').length >= 1);
  await t.close();
});

test('iniciar LIVE sem configuração é bloqueado', async () => {
  const t = await server();
  await t.login();
  const r = await t.req('POST', '/api/bot/command', { account: 'live', command: 'start', confirm: true });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /LIVE TRADING BLOCKED/);
  await t.close();
});

test('comando inválido e conta inválida são rejeitados', async () => {
  const t = await server();
  await t.login();
  assert.equal((await t.req('POST', '/api/bot/command', { account: 'paper', command: 'rm -rf' })).status, 400);
  assert.equal((await t.req('POST', '/api/bot/command', { account: 'hacker', command: 'start' })).status, 400);
  await t.close();
});

test('configurações: validação, confirmação obrigatória e registro de alteração', async () => {
  const t = await server();
  await t.login();
  assert.equal((await t.req('PUT', '/api/settings', { account: 'paper', values: { stopLossPercent: 5 } })).status, 400);
  assert.equal((await t.req('PUT', '/api/settings', { account: 'paper', confirm: true, values: { stopLossPercent: -1 } })).status, 400);
  assert.equal((await t.req('PUT', '/api/settings', { account: 'paper', confirm: true, values: { apiKey: 'x' } })).status, 400);
  assert.equal((await t.req('PUT', '/api/settings', { account: 'paper', confirm: true, values: { strategyParams: { naoExiste: 1 } } })).status, 400);
  assert.equal((await t.req('PUT', '/api/settings', { account: 'paper', confirm: true, values: { strategyParams: { fastPeriod: 50, slowPeriod: 10 } } })).status, 400);
  const ok = await t.req('PUT', '/api/settings', { account: 'paper', confirm: true, values: { stopLossPercent: 3, strategyParams: { rsiBuyMax: 65 } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.values.stopLossPercent, 3);
  assert.equal(ok.data.values.strategyParams.rsiBuyMax, 65);
  assert.equal(ok.data.values.strategyParams.fastPeriod, 9);
  assert.ok(t.events('SETTINGS_CHANGED').length === 1);
  const got = await t.req('GET', '/api/settings?account=paper');
  assert.equal(JSON.stringify(got.data).match(/secret|apiKey/i), null, 'nada sensível nas configurações');
  await t.close();
});

test('não troca de ativo com posição aberta', async () => {
  const t = await server();
  await t.login();
  t.repo.openTrade({ account_id: 'paper', symbol: 'BTC-BRL', entry_price: 1, quantity: 1, entry_cost: 1, fees: 0, strategy: 'x', entry_order_id: null });
  t.repo.createPosition({ account_id: 'paper', symbol: 'BTC-BRL', quantity: 1, average_price: 1, stop_price: 1, take_profit_price: 1, trade_id: 1 });
  assert.equal((await t.req('PUT', '/api/settings', { account: 'paper', confirm: true, values: { symbol: 'ETH-BRL' } })).status, 409);
  await t.close();
});

test('exportação CSV protege contra injeção de fórmula', async () => {
  const t = await server();
  await t.login();
  t.repo.addEvent({ accountId: 'paper', category: 'SYSTEM', event: 'X', message: '=HYPERLINK("http://evil")' });
  const r = await t.req('GET', '/api/export/history.csv?account=paper');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.ok(r.data.includes("'=HYPERLINK"));
  assert.equal((await t.req('GET', '/api/export/senhas.csv?account=paper')).status, 400);
  await t.close();
});

test('paginação e filtros de logs', async () => {
  const t = await server();
  await t.login();
  for (let i = 0; i < 30; i++) t.repo.addEvent({ accountId: 'paper', category: 'TRADE', event: 'E', severity: i % 2 ? 'TRADE' : 'INFO', message: `m${i}` });
  const r = await t.req('GET', '/api/events?account=paper&severity=TRADE&pageSize=10&page=1');
  assert.equal(r.data.rows.length, 10);
  assert.ok(r.data.rows.every((e) => e.severity === 'TRADE'));
  assert.equal((await t.req('GET', '/api/events?account=paper&severity=DROP')).status, 400);
  await t.close();
});

test('WebSocket exige sessão e envia estado', async () => {
  const t = await server();
  const wsUrl = t.base.replace('http', 'ws') + '/ws';
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on('open', resolve);
    ws.on('error', reject);
  }));
  await t.login();
  const msg = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Cookie: t.cookie } });
    ws.on('message', (m) => { ws.close(); resolve(JSON.parse(m)); });
    ws.on('error', reject);
  });
  assert.equal(msg.type, 'hello');
  assert.ok(Array.isArray(msg.accounts));
  await t.close();
});

test('logout encerra a sessão', async () => {
  const t = await server();
  await t.login();
  assert.equal((await t.req('POST', '/api/auth/logout')).status, 200);
  assert.equal((await t.req('GET', '/api/bot/status')).status, 401);
  await t.close();
});

test('bloqueio por usuário: 5 senhas erradas travam o login por 1h, mesmo com a senha certa', async () => {
  const t = await server();
  for (let i = 0; i < 4; i++) assert.equal((await t.req('POST', '/api/auth/login', { username: 'admin', password: `errada${i}` })).status, 401);
  assert.equal((await t.req('POST', '/api/auth/login', { username: 'admin', password: 'errada-final' })).status, 401);
  const r = await t.req('POST', '/api/auth/login', { username: 'admin', password: 'senha-muito-segura' });
  assert.equal(r.status, 423);
  assert.match(r.data.error, /bloqueado/);
  assert.ok(t.events('USER_LOCKED').length === 1);
  // passado o bloqueio, entra e o contador zera
  t.db.prepare("UPDATE users SET locked_until = 0 WHERE username = 'admin'").run();
  assert.equal((await t.login()).status, 200);
  assert.equal(t.repo.getUser('admin').failed_attempts, 0);
  await t.close();
});
