import { openDatabase } from '../src/database/db.js';
import { Repo } from '../src/database/repo.js';
import { Logger } from '../src/monitoring/logger.js';
import { loadConfig } from '../src/config/index.js';
import { PaperBroker } from '../src/paper/PaperBroker.js';
import { BrokerError, ErrorKind } from '../src/broker/errors.js';
import { Engine } from '../src/bot/Engine.js';
import { registerAccounts, PAPER_ACCOUNT } from '../src/bot/accounts.js';

export const RULES = {
  symbol: 'BTC-BRL', base: 'BTC', quote: 'BRL', minVolume: 0.0000015, maxVolume: 19.5, minCost: 0.9, maxCost: 1_000_000,
  minPrice: 1, maxPrice: 10_000_000, stepSize: '0.00000001', tradable: true, session: '24x7', timezone: 'America/Sao_Paulo',
};

// Fonte de dados de mercado controlável pelo teste.
export class FakeData {
  constructor({ price = 100_000, now = () => Date.now() } = {}) {
    this.now = now;
    this.rules = { ...RULES };
    this.setPrice(price);
    this.candles = [];
    this.book = { bids: [[price - 5, 10]], asks: [[price + 5, 10]] };
    this.healthy = true;
  }
  setPrice(p, spread = 10) {
    this.ticker = { symbol: 'BTC-BRL', bid: p - spread / 2, ask: p + spread / 2, last: p, high: p, low: p, volume: 100, quoteVolume: 100 * p, ts: this.now() };
  }
  health() { return { ok: this.healthy, circuit: 'CLOSED' }; }
  async getSymbolRules() { return { ...this.rules }; }
  async getTicker() { return { ...this.ticker, ts: this.now() }; }
  async getOrderBook() { return this.book; }
  async getCandles() { return this.candles; }
  isMarketOpen(r) { return !!r.tradable; }
}

// Série de candles de 15m terminando no último candle fechado antes de `nowMs`.
export function makeCandles(closes, nowMs = Date.now(), tf = 900) {
  const lastClosed = Math.floor(nowMs / 1000 / tf) * tf - tf;
  const start = lastClosed - (closes.length - 1) * tf;
  return closes.map((c, i) => ({ t: start + i * tf, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }));
}

// Closes que produzem um cruzamento de alta da EMA9 sobre a EMA21 no último candle,
// com RSI moderado e preço acima da EMA50.
export function bullishCrossCloses() {
  const out = [];
  for (let i = 0; i < 60; i++) out.push(100_000 + i * 50);          // tendência de alta
  for (let i = 0; i < 25; i++) out.push(103_000 - i * 60);          // correção: EMA9 abaixo da EMA21
  let p = out.at(-1);
  for (;;) {                                                        // recuperação até cruzar
    p += 180;
    out.push(p);
    const { ema } = EMA;
    const f = ema(out, 9); const s = ema(out, 21);
    const n = out.length - 1;
    if (f[n - 1] <= s[n - 1] && f[n] > s[n]) break;
    if (out.length > 300) throw new Error('não cruzou');
  }
  return out;
}
import * as EMA from '../src/bot/strategy/indicators.js';

// Envolve um broker e injeta falhas por método.
// faults[method] = ErrorKind | 'PLACED_THEN_TIMEOUT' | function
export class FaultyBroker {
  constructor(inner) {
    this.inner = inner;
    this.name = inner.name;
    this.faults = {};
    this.calls = {};
    return new Proxy(this, {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        const v = inner[prop];
        if (typeof v !== 'function') return v;
        return async (...args) => {
          target.calls[prop] = (target.calls[prop] || 0) + 1;
          const f = target.faults[prop];
          if (f === 'PLACED_THEN_TIMEOUT') {
            await v.apply(inner, args); // a ordem é criada, mas a resposta "se perde"
            throw new BrokerError(ErrorKind.TIMEOUT, 'timeout simulado após envio');
          }
          if (typeof f === 'function') return f(...args);
          if (f) throw new BrokerError(f, `falha simulada ${f}`);
          return v.apply(inner, args);
        };
      },
    });
  }
  health() { return this.inner.health(); }
  isMarketOpen(r, d) { return this.inner.isMarketOpen(r, d); }
  reset(c) { return this.inner.reset(c); }
}

export function setup({ price = 100_000, capital = 20, env = {}, fee = 0.5, slippage = 0 } = {}) {
  let clock = Date.parse('2026-09-25T15:07:00Z');
  const now = () => clock;
  const config = loadConfig({
    DATABASE_URL: ':memory:', TRADING_ENABLED: 'true', INITIAL_CAPITAL: String(capital),
    MAX_DAILY_LOSS: '1', MAX_DAILY_TRADES: '4', STOP_LOSS_PERCENT: '2', TAKE_PROFIT_PERCENT: '3', MAX_ORDER_VALUE: '20',
    MAX_POSITION_PERCENT: '95', MAX_SPREAD_PERCENT: '0.5', MIN_24H_VOLUME: '1000',
    // Isola os testes do .env real do servidor.
    TRADING_MODE: 'paper', LIVE_TRADING_CONFIRM: 'false', COOKIE_SECURE: 'false', NODE_ENV: 'test',
    API_KEY: '', API_SECRET: '', CREDENTIALS_KEY: '', JWT_SECRET: '', ...env,
  });
  config.liveBlockReason = 'TRADING_MODE não é live';
  const db = openDatabase(':memory:');
  const repo = new Repo(db);
  const log = new Logger({ repo, quiet: true });
  registerAccounts(repo);
  const data = new FakeData({ price, now });
  const paper = new PaperBroker({ db, accountId: 'paper', dataSource: data, feePercent: fee, slippagePercent: slippage, initialCapital: capital });
  const broker = new FaultyBroker(paper);
  const engine = new Engine({ account: PAPER_ACCOUNT, broker, repo, db, config, log: log.child('paper'), now, orderPollDelayMs: 0, notFoundGraceMs: 0 });
  return {
    config, db, repo, log, data, paper, broker, engine,
    now,
    advance(ms) { clock += ms; },
    events(event) { return repo.listEvents({ accountId: 'paper', limit: 500 }).rows.filter((e) => !event || e.event === event); },
  };
}
