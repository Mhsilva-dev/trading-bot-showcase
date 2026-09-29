import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MT5BridgeBroker } from '../src/broker/MT5BridgeBroker.js';
import { ErrorKind } from '../src/broker/errors.js';
import { Engine } from '../src/bot/Engine.js';
import { XP_ACCOUNT } from '../src/bot/accounts.js';
import { mt5ShouldRun } from '../src/mt5/schedule.js';
import { setup, makeCandles, bullishCrossCloses } from './helpers.js';

// EA falso: mesmo protocolo de arquivos do TradingBridge.mq5.
class FakeEA {
  constructor(dir, { price = 12, now = () => Date.now() } = {}) {
    this.dir = dir;
    this.now = now;
    this.price = price;
    this.balance = 1000;
    this.positions = new Map();
    this.tradeMode = 0; // demo
    this.connected = true;
    this.respond = true;
    this.retcode = 10009;
    this.offset = -3 * 3600; // servidor em UTC-3
    this.orders = 0;
    fs.mkdirSync(path.join(dir, 'in'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    this.publish();
    this.timer = setInterval(() => this.cycle(), 20);
    this.timer.unref();
  }
  sym(symbol) {
    const p = this.price;
    return { symbol, bid: p - 0.01, ask: p + 0.01, last: p, volume_min: 1, volume_max: 10000, volume_step: 1, turnover: 5e6, trade_full: true, session_open: true, asks: [[p + 0.01, 5000]], bids: [[p - 0.01, 5000]] };
  }
  publish() {
    const ts = Math.floor(this.now() / 1000);
    let posValue = 0;
    const positions = [...this.positions.entries()].map(([symbol, v]) => { posValue += v.volume * (this.price - 0.01); return { symbol, type: 'BUY', volume: v.volume, price_open: v.price }; });
    const state = {
      ts, server_time: ts + this.offset, connected: this.connected, terminal_trade_allowed: true, ea_trade_allowed: true,
      account: { login: 12345678, server: 'XPMT5-DEMO', company: 'XP', currency: 'BRL', trade_mode: this.tradeMode, balance: this.balance, equity: this.balance + posValue, margin_free: this.balance },
      positions, orders: [], symbols: ['PETR4F', 'BBDC4F'].map((s) => this.sym(s)),
    };
    fs.writeFileSync(path.join(this.dir, 'state.json'), JSON.stringify(state));
  }
  cycle() {
    for (const f of fs.readdirSync(path.join(this.dir, 'in')).filter((x) => x.endsWith('.txt'))) {
      if (!this.respond) continue;
      const text = fs.readFileSync(path.join(this.dir, 'in', f), 'utf8');
      const kv = Object.fromEntries(text.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      const out = path.join(this.dir, 'out', `${kv.id}.json`);
      if (!fs.existsSync(out)) {
        let res;
        if (kv.type === 'order') {
          this.orders += 1;
          const ok = this.retcode === 10009;
          const vol = Number(kv.volume);
          const px = kv.side === 'BUY' ? this.price + 0.01 : this.price - 0.01;
          if (ok) {
            const cur = this.positions.get(kv.symbol) || { volume: 0, price: px };
            if (kv.side === 'BUY') { this.positions.set(kv.symbol, { volume: cur.volume + vol, price: px }); this.balance -= vol * px; }
            else { const left = cur.volume - vol; if (left > 0) this.positions.set(kv.symbol, { ...cur, volume: left }); else this.positions.delete(kv.symbol); this.balance += vol * px; }
          }
          res = { id: kv.id, ok, message: ok ? 'done' : 'no money', retcode: this.retcode, order: 1000 + this.orders, deal: 2000 + this.orders, price: ok ? px : 0, volume: ok ? vol : 0, commission: 0, fee: 0, comment: kv.comment };
        } else {
          res = { id: kv.id, ok: false, message: 'not_found', retcode: 0 };
        }
        fs.writeFileSync(out, JSON.stringify(res));
      }
      fs.rmSync(path.join(this.dir, 'in', f));
    }
    this.publish();
  }
  writeRates(symbol, closes) {
    const c = makeCandles(closes, this.now());
    fs.writeFileSync(path.join(this.dir, `rates_${symbol}_15m.json`), JSON.stringify({
      t: c.map((k) => k.t + this.offset), o: c.map((k) => k.o), h: c.map((k) => k.h), l: c.map((k) => k.l), c: c.map((k) => k.c), v: c.map(() => 100),
    }));
  }
  stop() { clearInterval(this.timer); }
}

function mk(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt5-'));
  const ea = new FakeEA(dir, opts);
  const broker = new MT5BridgeBroker({ bridgeDir: dir, orderTimeoutMs: 800, pollMs: 20, feePercent: 0.05, expectedEnvironment: () => ('env' in opts ? opts.env : 'demo'), allowReal: () => false, scheduledOn: opts.scheduledOn || (() => true) });
  return { dir, ea, broker, done: () => { ea.stop(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('regras do ativo vêm do MT5: mínimo 1 ação, passo 1, pregão aberto', async () => {
  const t = mk();
  const r = await t.broker.getSymbolRules('PETR4F');
  assert.equal(r.minVolume, 1);
  assert.equal(r.stepSize, '1');
  assert.ok(r.minCost > 12 && r.minCost < 12.1);
  assert.equal(t.broker.isMarketOpen(r), true);
  assert.ok(fs.readFileSync(path.join(t.dir, 'symbols.txt'), 'utf8').includes('PETR4F'));
  t.done();
});

test('compra por valor converte em nº inteiro de ações e registra execução', async () => {
  const t = mk();
  const o = await t.broker.createOrder({ symbol: 'PETR4F', side: 'BUY', cost: 50, externalId: 'tb-xp-teste-0001' });
  assert.equal(o.status, 'FILLED');
  assert.equal(o.filledQty, 4); // floor(50 / 12.01)
  assert.equal(o.avgPrice, 12.01);
  assert.ok(o.feeQuote > 0, 'aplica custo estimado quando o MT5 não informa comissão');
  assert.equal((await t.broker.getOrder('PETR4F', 'tb-xp-teste-0001')).filledQty, 4);
  t.done();
});

test('saldo: caixa = patrimônio - posições; posição aparece pelo símbolo', async () => {
  const t = mk();
  await t.broker.createOrder({ symbol: 'PETR4F', side: 'BUY', cost: 50, externalId: 'tb-xp-teste-0002' });
  await new Promise((r) => setTimeout(r, 60));
  const b = await t.broker.getBalance();
  assert.equal(b.PETR4F.total, 4);
  assert.ok(Math.abs(b.BRL.total - (1000 - 4 * 12.01)) < 1e-6);
  t.done();
});

test('mesmo externalId nunca é enviado duas vezes', async () => {
  const t = mk();
  await t.broker.createOrder({ symbol: 'PETR4F', side: 'BUY', cost: 50, externalId: 'tb-xp-teste-0003' });
  await assert.rejects(t.broker.createOrder({ symbol: 'PETR4F', side: 'BUY', cost: 50, externalId: 'tb-xp-teste-0003' }), /já usado/);
  assert.equal(t.ea.orders, 1);
  t.done();
});

test('ponte sem resposta -> TIMEOUT (estado desconhecido) e depois o resultado é recuperado', async () => {
  const t = mk();
  t.ea.respond = false;
  await assert.rejects(t.broker.createOrder({ symbol: 'PETR4F', side: 'BUY', cost: 50, externalId: 'tb-xp-teste-0004' }), (e) => e.kind === ErrorKind.TIMEOUT && e.unknownOutcome);
  // ainda na fila -> continua indefinido
  await assert.rejects(t.broker.findOrderByExternalId('PETR4F', 'tb-xp-teste-0004'), (e) => e.kind === ErrorKind.TIMEOUT);
  t.ea.respond = true;
  await new Promise((r) => setTimeout(r, 100));
  const o = await t.broker.findOrderByExternalId('PETR4F', 'tb-xp-teste-0004');
  assert.equal(o.status, 'FILLED');
  t.done();
});

test('recusa do MT5 por saldo é classificada', async () => {
  const t = mk();
  t.ea.retcode = 10019;
  await assert.rejects(t.broker.createOrder({ symbol: 'PETR4F', side: 'BUY', cost: 50, externalId: 'tb-xp-teste-0005' }), (e) => e.kind === ErrorKind.INSUFFICIENT_FUNDS);
  t.done();
});

test('volume abaixo de 1 ação é recusado antes de ir ao MT5', async () => {
  const t = mk();
  await assert.rejects(t.broker.createOrder({ symbol: 'PETR4F', side: 'BUY', cost: 5, externalId: 'tb-xp-teste-0006' }), /abaixo do mínimo/);
  assert.equal(t.ea.orders, 0);
  t.done();
});

test('proteções: sem cadastro, conta REAL com cadastro DEMO, desconectado, ponte parada', async () => {
  let t = mk({ env: null });
  await assert.rejects(t.broker.getTicker('PETR4F'), (e) => e.kind === ErrorKind.NOT_CONFIGURED);
  t.done();
  t = mk();
  t.ea.tradeMode = 2; t.ea.publish();
  await assert.rejects(t.broker.getTicker('PETR4F'), (e) => e.kind === ErrorKind.AUTH && /REAL/.test(e.message));
  t.done();
  t = mk();
  t.ea.connected = false; t.ea.publish();
  await assert.rejects(t.broker.getTicker('PETR4F'), (e) => e.kind === ErrorKind.NETWORK);
  t.done();
  t = mk({ now: () => Date.now() - 60_000 }); // estado velho
  t.ea.stop();
  await assert.rejects(t.broker.getTicker('PETR4F'), (e) => e.kind === ErrorKind.NETWORK && /sem sinal/.test(e.message));
  t.done();
});

test('fora do horário, ponte desligada é "mercado fechado" (não é falha)', async () => {
  const t = mk({ scheduledOn: () => false, now: () => Date.now() - 60_000 });
  t.ea.stop();
  await assert.rejects(t.broker.getTicker('PETR4F'), (e) => e.kind === ErrorKind.MARKET_CLOSED);
  t.done();
});

test('leilão de abertura (livro cruzado, bid > ask) é "mercado fechado", não erro', async () => {
  const t = mk();
  const sym = t.ea.sym.bind(t.ea);
  t.ea.sym = (s) => ({ ...sym(s), bid: 20.56, ask: 17.83 });
  t.ea.publish();
  await assert.rejects(t.broker.getTicker('PETR4F'), (e) => e.kind === ErrorKind.MARKET_CLOSED && /leilão/.test(e.message));
  t.done();
});

test('candles convertem o horário do servidor MT5 para UTC', async () => {
  const t = mk();
  t.ea.writeRates('PETR4F', [10, 11, 12]);
  await t.broker.getTicker('PETR4F'); // lê estado e calcula o offset
  const k = await t.broker.getCandles('PETR4F', '15m', 10);
  const expected = makeCandles([10, 11, 12], Date.now()).at(-1).t;
  assert.equal(k.at(-1).t, expected);
  await assert.rejects(t.broker.getCandles('PETR4F', '1h', 10), /15m/);
  t.done();
});

test('janela do MT5: dias úteis no horário configurado (Brasília)', () => {
  const cfg = { startTime: '09:30', stopTime: '18:15', alwaysOn: false };
  assert.equal(mt5ShouldRun(cfg, new Date('2026-09-25T13:00:00Z')), true);  // sex 10:00 BRT
  assert.equal(mt5ShouldRun(cfg, new Date('2026-09-25T22:00:00Z')), false); // sex 19:00 BRT
  assert.equal(mt5ShouldRun(cfg, new Date('2026-09-26T13:00:00Z')), false); // sábado
  assert.equal(mt5ShouldRun({ ...cfg, alwaysOn: true }, new Date('2026-09-26T13:00:00Z')), true);
});

test('Engine na conta XP: sincroniza, recebe BUY e compra ações inteiras pela ponte', async () => {
  const s = setup({ env: { MAX_ORDER_VALUE: '50', MIN_24H_VOLUME: '0' } });
  const t = mk({ price: 100 });
  const closes = bullishCrossCloses().map((c) => c / 1000); // ~R$100
  t.ea.price = closes.at(-1);
  t.ea.writeRates('PETR4F', closes);
  s.repo.setSettings('xp', { symbol: 'PETR4F', timeframe: '15m', strategyParams: { rsiBuyMax: 90 }, maxOrderValue: 250, maxSpreadPercent: 1 });
  const e = new Engine({ account: XP_ACCOUNT, broker: t.broker, repo: s.repo, db: s.db, config: s.config, log: s.log.child('xp'), orderPollDelayMs: 0 });
  await e.init();
  await e.handleCommand({ command: 'start' });
  await e.tick();
  const st = s.repo.getState('xp');
  const pos = s.repo.openPosition('xp', 'PETR4F');
  assert.ok(pos, `${st.status}: ${st.reason} | ${s.repo.listEvents({ accountId: 'xp', limit: 20 }).rows.map((x) => x.message).join(' / ')}`);
  assert.equal(pos.quantity, Math.floor(237.5 / (t.ea.price + 0.01))); // 95% de R$250
  assert.equal(Number.isInteger(pos.quantity), true);
  t.done();
});

test('Engine na conta XP sem cadastro fica ociosa (IDLE), sem FAIL SAFE nem spam de log', async () => {
  const s = setup();
  const t = mk({ env: null });
  const e = new Engine({ account: XP_ACCOUNT, broker: t.broker, repo: s.repo, db: s.db, config: s.config, log: s.log.child('xp') });
  for (let i = 0; i < 8; i++) await e.tick();
  assert.equal(s.repo.getState('xp').status, 'IDLE');
  assert.equal(e.failSafe, null);
  assert.equal(s.repo.listEvents({ accountId: 'xp', limit: 100 }).rows.filter((x) => x.event === 'BROKER_IDLE').length, 1, 'registra uma vez só');
  t.done();
});

test('MT5 reiniciando (launcher avisa STARTING): bot espera sem contar erro nem entrar em FAIL SAFE', async () => {
  const s = setup();
  const t = mk({ now: () => Date.now() - 60_000 }); // estado velho, como durante o reinício
  t.ea.stop();
  fs.writeFileSync(path.join(t.dir, 'launcher.json'), JSON.stringify({ status: 'STARTING', ts: Date.now() }));
  await assert.rejects(t.broker.getTicker('PETR4F'), (e) => e.kind === ErrorKind.STARTING);
  const e = new Engine({ account: XP_ACCOUNT, broker: t.broker, repo: s.repo, db: s.db, config: s.config, log: s.log.child('xp') });
  for (let i = 0; i < 8; i++) await e.tick();
  assert.equal(e.failSafe, null);
  assert.equal(s.repo.getState('xp').status, 'IDLE');
  // aviso velho (>5 min) não serve de desculpa: volta a ser falha
  fs.writeFileSync(path.join(t.dir, 'launcher.json'), JSON.stringify({ status: 'STARTING', ts: Date.now() - 10 * 60_000 }));
  await assert.rejects(t.broker.getTicker('PETR4F'), (e2) => e2.kind === ErrorKind.NETWORK);
  t.done();
});
