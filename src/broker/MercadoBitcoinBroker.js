// Adapter do Mercado Bitcoin — API v4.
// Referência: https://api.mercadobitcoin.net/api/v4/docs (swagger.yaml oficial)
//
// Endpoints usados (todos da documentação oficial):
//   POST /oauth2/token                              (client_credentials)
//   GET  /accounts
//   GET  /accounts/{accountId}/balances
//   GET  /accounts/{accountId}/{symbol}/orders      (lista; filtra por status)
//   POST /accounts/{accountId}/{symbol}/orders      (cria)
//   GET  /accounts/{accountId}/{symbol}/orders/{id}
//   DELETE /accounts/{accountId}/{symbol}/orders/{id}
//   GET  /accounts/{accountId}/{symbol}/fees
//   GET  /symbols, /tickers, /candles, /{symbol}/orderbook   (públicos)
import { BrokerAdapter } from './BrokerAdapter.js';
import { BrokerError, ErrorKind } from './errors.js';
import { HttpClient, CircuitBreaker } from './http.js';
import { toNum } from '../lib/util.js';

const STATUS_MAP = { created: 'OPEN', working: 'OPEN', cancelled: 'CANCELED', filled: 'FILLED' };

export class MercadoBitcoinBroker extends BrokerAdapter {
  constructor({ apiKey = '', apiSecret = '', baseUrl = 'https://api.mercadobitcoin.net/api/v4', accountId = '', fetchImpl, timeoutMs = 10_000, breaker, baseDelayMs } = {}) {
    super('mercadobitcoin');
    this.clientId = apiKey;
    this.clientSecret = apiSecret;
    this.accountId = accountId;
    this.breaker = breaker || new CircuitBreaker({ threshold: 5, cooldownMs: 60_000 });
    this.http = new HttpClient({ baseUrl, fetchImpl, timeoutMs, breaker: this.breaker, baseDelayMs });
    this.token = null;
    this.tokenExp = 0;
    this.lastError = null;
  }

  get hasCredentials() {
    return !!(this.clientId && this.clientSecret);
  }

  health() {
    return { ok: this.breaker.state !== 'OPEN' && !this.lastError, circuit: this.breaker.state, message: this.lastError };
  }

  async track(promise) {
    try {
      const r = await promise;
      this.lastError = null;
      return r;
    } catch (e) {
      if (e.retryable || e.kind === ErrorKind.CIRCUIT_OPEN || e.kind === ErrorKind.AUTH) this.lastError = `${e.kind}: ${e.message}`;
      throw e;
    }
  }

  // ---------- autenticação ----------
  async authHeaders() {
    if (!this.hasCredentials) throw new BrokerError(ErrorKind.AUTH, 'Credenciais da corretora não configuradas');
    if (!this.token || Date.now() > this.tokenExp - 60_000) {
      const r = await this.http.request('POST', '/oauth2/token', {
        form: { grant_type: 'client_credentials', scope: 'global', client_id: this.clientId, client_secret: this.clientSecret },
        retry: 2, rateKey: 'auth', minIntervalMs: 1000,
      });
      if (!r?.access_token) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Token ausente na resposta de autenticação');
      this.token = r.access_token;
      this.tokenExp = Date.now() + toNum(r.expires_in ?? 3599, 'expires_in') * 1000;
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  async priv(method, path, opts = {}) {
    const headers = await this.authHeaders();
    try {
      return await this.http.request(method, path, { ...opts, headers });
    } catch (e) {
      // Token expirado/revogado: renova uma vez.
      if (e.kind === ErrorKind.AUTH && this.token) {
        this.token = null;
        const h2 = await this.authHeaders();
        return this.http.request(method, path, { ...opts, headers: h2 });
      }
      throw e;
    }
  }

  async init() {
    if (!this.hasCredentials) return;
    await this.track(this.resolveAccount());
  }

  async resolveAccount() {
    if (this.accountId) return this.accountId;
    const list = await this.priv('GET', '/accounts', { retry: 2 });
    if (!Array.isArray(list) || !list.length || !list[0].id) {
      throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Nenhuma conta retornada por /accounts');
    }
    this.accountId = list[0].id;
    return this.accountId;
  }

  // ---------- dados públicos ----------
  async getSymbolRules(symbol) {
    const r = await this.track(this.http.request('GET', '/symbols', { query: { symbols: symbol }, retry: 3, rateKey: 'symbols', minIntervalMs: 1000 }));
    const i = r?.symbol?.indexOf(symbol);
    if (i === undefined || i < 0) throw new BrokerError(ErrorKind.NOT_FOUND, `Símbolo ${symbol} não encontrado`);
    return {
      symbol,
      base: r['base-currency'][i],
      quote: r.currency[i],
      minVolume: toNum(r['min-volume'][i], 'min-volume'),
      maxVolume: toNum(r['max-volume'][i], 'max-volume'),
      minCost: toNum(r['min-cost'][i], 'min-cost'),
      maxCost: toNum(r['max-cost'][i], 'max-cost'),
      minPrice: toNum(r['min-price'][i], 'min-price'),
      maxPrice: toNum(r['max-price'][i], 'max-price'),
      stepSize: String(r['round-lot'][i]),
      tradable: r['exchange-traded'][i] === true && r['exchange-listed'][i] === true,
      session: r['session-regular'][i],
      timezone: r.timezone[i],
    };
  }

  async getTicker(symbol) {
    const r = await this.track(this.http.request('GET', '/tickers', { query: { symbols: symbol }, retry: 3, rateKey: 'tickers', minIntervalMs: 1000 }));
    const t = Array.isArray(r) ? r.find((x) => x.pair === symbol) : null;
    if (!t) throw new BrokerError(ErrorKind.INVALID_RESPONSE, `Ticker de ${symbol} ausente`);
    const last = toNum(t.last, 'last');
    const vol = toNum(t.vol, 'vol');
    // Na doc do MB: buy = maior preço de compra (bid), sell = menor preço de venda (ask)
    return {
      symbol,
      bid: toNum(t.buy, 'buy'),
      ask: toNum(t.sell, 'sell'),
      last,
      high: toNum(t.high, 'high'),
      low: toNum(t.low, 'low'),
      volume: vol,
      quoteVolume: vol * last,
      ts: toNum(t.date, 'date') * 1000,
    };
  }

  async getOrderBook(symbol, limit = 20) {
    const r = await this.track(this.http.request('GET', `/${encodeURIComponent(symbol)}/orderbook`, { query: { limit }, retry: 3, rateKey: 'orderbook', minIntervalMs: 1000 }));
    if (!Array.isArray(r?.asks) || !Array.isArray(r?.bids)) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Orderbook inválido');
    const conv = (rows) => rows.map(([p, q]) => [toNum(p, 'price'), toNum(q, 'qty')]);
    return { bids: conv(r.bids), asks: conv(r.asks), ts: r.timestamp ? Number(r.timestamp) : Date.now() };
  }

  async getCandles(symbol, timeframe, count = 200, to = Math.floor(Date.now() / 1000)) {
    const r = await this.track(this.http.request('GET', '/candles', {
      query: { symbol, resolution: timeframe, to, countback: count }, retry: 3, rateKey: 'candles', minIntervalMs: 1000,
    }));
    if (!r || !Array.isArray(r.t)) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Candles inválidos');
    return r.t.map((t, i) => ({
      t: toNum(t, 't'), o: toNum(r.o[i], 'o'), h: toNum(r.h[i], 'h'), l: toNum(r.l[i], 'l'), c: toNum(r.c[i], 'c'), v: toNum(r.v[i], 'v'),
    }));
  }

  // Busca um intervalo histórico (backtest), paginando com `to`.
  async getCandlesRange(symbol, timeframe, fromSec, toSec, stepSec) {
    const out = new Map();
    let to = toSec;
    for (let guard = 0; guard < 100 && to > fromSec; guard++) {
      const page = await this.getCandles(symbol, timeframe, 500, to);
      if (!page.length) break;
      for (const k of page) if (k.t >= fromSec && k.t <= toSec) out.set(k.t, k);
      const oldest = page[0].t;
      if (oldest >= to) break;
      to = oldest - stepSec;
    }
    return [...out.values()].sort((a, b) => a.t - b.t);
  }

  // ---------- conta ----------
  async getBalance() {
    const acc = await this.resolveAccount();
    const r = await this.track(this.priv('GET', `/accounts/${acc}/balances`, { retry: 3, rateKey: 'balances', minIntervalMs: 350 }));
    if (!Array.isArray(r)) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Saldos inválidos');
    const out = {};
    for (const b of r) {
      out[b.symbol] = { available: toNum(b.available, 'available'), onHold: toNum(b.on_hold, 'on_hold'), total: toNum(b.total, 'total') };
    }
    return out;
  }

  async getFees(symbol) {
    const acc = await this.resolveAccount();
    const r = await this.track(this.priv('GET', `/accounts/${acc}/${symbol}/fees`, { retry: 2 }));
    return { maker: toNum(r.maker_fee, 'maker_fee'), taker: toNum(r.taker_fee, 'taker_fee') };
  }

  normalizeOrder(o) {
    if (!o || !o.id) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Ordem inválida na resposta');
    const filledQty = Number(o.filledQty || 0);
    let status = STATUS_MAP[o.status];
    if (!status) throw new BrokerError(ErrorKind.INVALID_RESPONSE, `Status de ordem desconhecido: ${o.status}`);
    if (o.status === 'working' && filledQty > 0) status = 'PARTIAL';
    const side = o.side === 'buy' ? 'BUY' : 'SELL';
    const fee = Number(o.fee || 0);
    const avgPrice = Number(o.avgPrice || 0) || null;
    return {
      id: String(o.id),
      externalId: o.externalId || o.external_id || null,
      symbol: o.instrument,
      side,
      type: o.type,
      qty: o.qty !== undefined ? Number(o.qty) : null,
      cost: o.cost !== undefined ? Number(o.cost) : null,
      status,
      filledQty,
      avgPrice,
      // "fee: Charged volume by fee application" — na compra a taxa sai do
      // ativo recebido; na venda, do valor em reais. A reconciliação confere.
      feeBase: side === 'BUY' ? fee : 0,
      feeQuote: side === 'SELL' ? fee : 0,
      createdAt: o.created_at ? o.created_at * 1000 : null,
      updatedAt: o.updated_at ? o.updated_at * 1000 : null,
    };
  }

  async getOpenOrders(symbol) {
    const acc = await this.resolveAccount();
    const res = [];
    for (const status of ['created', 'working']) {
      const r = await this.track(this.priv('GET', `/accounts/${acc}/${symbol}/orders`, { query: { status }, retry: 3, rateKey: 'listOrders', minIntervalMs: 150 }));
      if (!Array.isArray(r)) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Lista de ordens inválida');
      res.push(...r.map((o) => this.normalizeOrder(o)));
    }
    return res;
  }

  async getPositions(symbols) {
    // Spot: "posição" = saldo do ativo base.
    const bal = await this.getBalance();
    return symbols.map((s) => {
      const base = s.split('-')[0];
      return { symbol: s, quantity: bal[base]?.total ?? 0 };
    });
  }

  async createOrder({ symbol, side, type = 'market', qty, cost, externalId }) {
    const acc = await this.resolveAccount();
    const body = { side: side === 'BUY' ? 'buy' : 'sell', type, externalId, async: false };
    if (cost !== undefined && cost !== null) body.cost = cost; else body.qty = String(qty);
    // SEM retry: criar ordem não é idempotente. Falha ambígua -> estado UNKNOWN.
    const r = await this.track(this.priv('POST', `/accounts/${acc}/${symbol}/orders`, { body, retry: 0, rateKey: 'placeOrder', minIntervalMs: 350 }));
    if (!r?.orderId) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'orderId ausente na criação da ordem');
    return this.getOrder(symbol, String(r.orderId));
  }

  async getOrder(symbol, orderId) {
    const acc = await this.resolveAccount();
    const r = await this.track(this.priv('GET', `/accounts/${acc}/${symbol}/orders/${orderId}`, { retry: 3, rateKey: 'getOrder', minIntervalMs: 1000 }));
    return this.normalizeOrder(r);
  }

  async cancelOrder(symbol, orderId) {
    const acc = await this.resolveAccount();
    await this.track(this.priv('DELETE', `/accounts/${acc}/${symbol}/orders/${orderId}`, { query: { async: false }, retry: 0, rateKey: 'cancel', minIntervalMs: 350 }));
    return this.getOrder(symbol, orderId);
  }

  async findOrderByExternalId(symbol, externalId, sinceSec) {
    const acc = await this.resolveAccount();
    const r = await this.track(this.priv('GET', `/accounts/${acc}/${symbol}/orders`, {
      query: sinceSec ? { created_at_from: Math.floor(sinceSec) - 60 } : undefined, retry: 3, rateKey: 'listOrders', minIntervalMs: 150,
    }));
    if (!Array.isArray(r)) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Lista de ordens inválida');
    const hit = r.find((o) => (o.externalId || o.external_id) === externalId);
    return hit ? this.normalizeOrder(hit) : null;
  }

  isMarketOpen(rules) {
    return !!rules?.tradable && (rules.session === '24x7' || !rules.session);
  }
}
