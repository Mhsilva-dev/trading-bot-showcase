import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { setup } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { encrypt, decrypt, parseKey, maskLogin } from '../src/security/vault.js';
import { getBrokerCredential } from '../src/security/credentials.js';

const KEY = crypto.randomBytes(32).toString('hex');
const MT5_PASSWORD = 'Mt5-Senha-Secreta-987';

test('cofre: cifra/decifra, detecta adulteração, chave errada e troca de dono', () => {
  const k = parseKey(KEY);
  const c = encrypt(k, 'segredo', 'xp_mt5');
  assert.ok(!c.includes('segredo'));
  assert.notEqual(c, encrypt(k, 'segredo', 'xp_mt5'), 'IV aleatório');
  assert.equal(decrypt(k, c, 'xp_mt5'), 'segredo');
  const parts = c.split(':'); parts[3] = Buffer.from('xxxxxxx').toString('base64');
  assert.throws(() => decrypt(k, parts.join(':'), 'xp_mt5'));
  assert.throws(() => decrypt(parseKey(crypto.randomBytes(32).toString('hex')), c, 'xp_mt5'));
  assert.throws(() => decrypt(k, c, 'outro_provider'));
  assert.throws(() => parseKey('curta'));
  assert.equal(maskLogin('12345678'), '*****678');
});

async function server({ key = KEY } = {}) {
  const s = setup();
  s.config.dashboard.sessionSecret = 'y'.repeat(40);
  s.config.credentialsKey = key;
  s.repo.upsertUser('admin', bcrypt.hashSync('senha-do-painel-ok', 4));
  const { app } = createApp({ db: s.db, repo: s.repo, config: s.config, log: s.log, marketData: null, staticDir: '/x' });
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  let cookie = ''; let csrf = '';
  const req = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    return { status: res.status, data: JSON.parse(text), text };
  };
  const l = await req('POST', '/api/auth/login', { username: 'admin', password: 'senha-do-painel-ok' });
  csrf = l.data.csrfToken;
  return { ...s, req, close: () => new Promise((r) => srv.close(r)) };
}

const VALID = { environment: 'demo', server: 'XPMT5-DEMO', login: '12345678', password: MT5_PASSWORD, currentPassword: 'senha-do-painel-ok' };

test('salvar conta XP exige a senha do painel', async () => {
  const t = await server();
  const r = await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, currentPassword: 'errada' });
  assert.equal(r.status, 403);
  assert.equal(t.repo.getCredential('xp_mt5'), undefined);
  assert.ok(t.events('REAUTH_FAILED').length === 1);
  await t.close();
});

test('salva cifrado, nunca devolve a senha e não registra a senha em log', async () => {
  const t = await server();
  const r = await t.req('PUT', '/api/connections/xp_mt5', VALID);
  assert.equal(r.status, 200);
  assert.equal(r.data.configured, true);
  assert.equal(r.data.login, '*****678');
  assert.ok(!r.text.includes(MT5_PASSWORD));
  const list = await t.req('GET', '/api/connections');
  assert.ok(!list.text.includes(MT5_PASSWORD) && !list.text.includes('12345678'));
  // banco guarda só o cifrado
  const raw = JSON.stringify(t.db.prepare('SELECT * FROM broker_credentials').all());
  assert.ok(!raw.includes(MT5_PASSWORD));
  // logs sem senha nem login completo
  const logs = JSON.stringify(t.repo.listEvents({ limit: 500 }).rows);
  assert.ok(!logs.includes(MT5_PASSWORD) && !logs.includes('12345678'));
  assert.ok(t.events('BROKER_CREDENTIAL_SAVED').length === 1);
  // backend consegue decifrar para a ponte MT5
  assert.deepEqual(getBrokerCredential(t.repo, KEY, 'xp_mt5'), { environment: 'demo', server: 'XPMT5-DEMO', login: '12345678', password: MT5_PASSWORD });
  await t.close();
});

test('validação: login numérico, servidor válido, campos extras recusados, provider desconhecido', async () => {
  const t = await server();
  assert.equal((await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, login: 'abc' })).status, 400);
  assert.equal((await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, server: '<script>' })).status, 400);
  assert.equal((await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, extra: 1 })).status, 400);
  assert.equal((await t.req('PUT', '/api/connections/itau', VALID)).status, 400);
  await t.close();
});

test('aceita servidor com porta (formato da XP)', async () => {
  const t = await server();
  const r = await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, server: 'demo.mt5.xpi.com.br:443' });
  assert.equal(r.status, 200);
  assert.equal(r.data.server, 'demo.mt5.xpi.com.br:443');
  assert.equal((await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, server: 'demo.mt5.xpi.com.br:abc' })).status, 400);
  await t.close();
});

test('recusa CPF no lugar do login do MT5 e não grava nada', async () => {
  const t = await server();
  const r = await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, login: '52998224725' }); // CPF de exemplo válido
  assert.equal(r.status, 400);
  assert.match(r.data.error, /CPF/);
  assert.equal(t.repo.getCredential('xp_mt5'), undefined);
  assert.ok(!JSON.stringify(t.repo.listEvents({ limit: 50 }).rows).includes('52998224725'));
  assert.equal((await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, login: '12345678901' })).status, 200, 'número de 11 dígitos que não é CPF passa');
  await t.close();
});

test('conta REAL exige confirmação explícita', async () => {
  const t = await server();
  const r = await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, environment: 'real' });
  assert.equal(r.status, 400);
  assert.equal(r.data.needsConfirm, true);
  assert.equal((await t.req('PUT', '/api/connections/xp_mt5', { ...VALID, environment: 'real', confirmReal: true })).status, 200);
  await t.close();
});

test('sem chave do cofre no servidor, não salva', async () => {
  const t = await server({ key: '' });
  assert.equal((await t.req('PUT', '/api/connections/xp_mt5', VALID)).status, 503);
  await t.close();
});

test('remover exige senha do painel e apaga o cifrado', async () => {
  const t = await server();
  await t.req('PUT', '/api/connections/xp_mt5', VALID);
  assert.equal((await t.req('DELETE', '/api/connections/xp_mt5', { currentPassword: 'x' })).status, 403);
  assert.equal((await t.req('DELETE', '/api/connections/xp_mt5', { currentPassword: 'senha-do-painel-ok' })).status, 200);
  assert.equal(t.repo.getCredential('xp_mt5'), undefined);
  await t.close();
});
