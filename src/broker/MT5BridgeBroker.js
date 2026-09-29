// Adapter MetaTrader 5 (XP) — conversa com o EA TradingBridge.mq5 por
// arquivos em MQL5/Files/bridge/:
//   state.json            estado publicado pelo EA a cada ~1s
//   rates_<SIM>_15m.json  candles M15
//   symbols.txt           símbolos que o EA deve acompanhar (escrito aqui)
//   in/<id>.txt           comando (escrito aqui, atômico: .tmp -> rename)
//   out/<id>.json         resultado (escrito pelo EA)
//
// O id do comando de ordem é o externalId do bot; o EA nunca reexecuta um id
// que já tem resultado, e recusa comandos com mais de 30s. Assim, depois de um
// timeout, o estado real é descoberto lendo out/<id>.json (ou buscando no
// histórico do MT5 pelo comentário).
import fs from 'node:fs';
import path from 'node:path';
import { BrokerAdapter } from './BrokerAdapter.js';
import { BrokerError, ErrorKind } from './errors.js';
import { floorToStep, sleep } from '../lib/util.js';

// Códigos de retorno do MT5 (TRADE_RETCODE_*)
const RC = { DONE: 10009, DONE_PARTIAL: 10010, PLACED: 10008, NO_MONEY: 10019, MARKET_CLOSED: 10018, TRADE_DISABLED: 10017, INVALID_VOLUME: 10014, NO_PRICES: 10021 };

export class MT5BridgeBroker extends BrokerAdapter {
  constructor({ bridgeDir, feePercent = 0.05, staleSec = 15, orderTimeoutMs = 15_000, pollMs = 250, expectedEnvironment = () => 'demo', allowReal = () => false, scheduledOn = () => true, now = () => Date.now() }) {
    super('xp_mt5');
    this.scheduledOn = scheduledOn;
    this.dir = bridgeDir;
    this.fee = feePercent / 100;
    this.staleSec = staleSec;
    this.orderTimeoutMs = orderTimeoutMs;
    this.pollMs = pollMs;
    this.expectedEnvironment = expectedEnvironment;
    this.allowReal = allowReal;
    this.now = now;
    this.lastState = null;
    this.lastError = null;
    this.watch = new Set();
  }

  file(...p) { return path.join(this.dir, ...p); }

  // ---------- estado ----------
  readState() {
    if (!this.expectedEnvironment()) {
      this.lastError = 'Conta XP não cadastrada — cadastre em Conexões no painel';
      throw new BrokerError(ErrorKind.NOT_CONFIGURED, this.lastError);
    }
    // Fora da janela o MT5 é desligado de propósito: é "mercado fechado", não falha.
    const offHours = () => {
      this.lastError = 'Fora do horário do pregão: MT5 desligado (volta automaticamente)';
      return new BrokerError(ErrorKind.MARKET_CLOSED, this.lastError);
    };
    // O launcher avisa quando está (re)iniciando o MT5: é espera, não falha.
    const starting = () => {
      try {
        const l = JSON.parse(fs.readFileSync(this.file('launcher.json'), 'utf8'));
        if (l.status === 'STARTING' && this.now() - l.ts < 5 * 60_000) {
          this.lastError = 'MetaTrader 5 iniciando (login na XP)…';
          return new BrokerError(ErrorKind.STARTING, this.lastError);
        }
      } catch { /* sem aviso do launcher */ }
      return null;
    };
    let raw;
    try {
      raw = fs.readFileSync(this.file('state.json'), 'utf8');
    } catch {
      if (!this.scheduledOn()) throw offHours();
      const st = starting(); if (st) throw st;
      this.lastError = 'Ponte MT5 ainda não publicou estado (MT5 iniciando ou EA não carregado)';
      throw new BrokerError(ErrorKind.NETWORK, this.lastError);
    }
    let s;
    try { s = JSON.parse(raw); } catch {
      throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'state.json da ponte MT5 inválido');
    }
    const age = this.now() / 1000 - Number(s.ts);
    if ((s.stopped || !(age <= this.staleSec)) && !this.scheduledOn()) throw offHours();
    if (s.stopped || !(age <= this.staleSec)) {
      const st = starting(); if (st) throw st;
      this.lastError = s.stopped ? 'EA da ponte MT5 parado' : `Ponte MT5 sem sinal há ${Math.round(age)}s`;
      throw new BrokerError(ErrorKind.NETWORK, this.lastError);
    }
    if (!s.connected) {
      this.lastError = 'MT5 desconectado do servidor da XP';
      throw new BrokerError(ErrorKind.NETWORK, this.lastError);
    }
    // A conta conectada precisa bater com o cadastro: DEMO é DEMO.
    const env = this.expectedEnvironment();
    const isReal = Number(s.account?.trade_mode) === 2;
    if (!env) throw new BrokerError(ErrorKind.NOT_CONFIGURED, 'Conta XP não cadastrada em Conexões');
    if (env === 'demo' && isReal) throw new BrokerError(ErrorKind.AUTH, 'MT5 está numa conta REAL, mas o cadastro é DEMO — operação bloqueada');
    if (isReal && !this.allowReal()) throw new BrokerError(ErrorKind.AUTH, 'Conta REAL exige TRADING_MODE=live e LIVE_TRADING_CONFIRM=true');
    // Diferença entre o relógio do servidor MT5 e UTC (candles vêm em horário do servidor).
    this.offsetSec = Math.round((Number(s.server_time) - Number(s.ts)) / 900) * 900;
    this.lastState = s;
    this.lastError = null;
    return s;
  }

  health() {
    try {
      this.readState();
      return { ok: true, circuit: 'CLOSED' };
    } catch (e) {
      return { ok: false, circuit: 'CLOSED', message: e.message };
    }
  }

  async init() {
    this.readState();
  }

  symbolInfo(symbol) {
    this.ensureWatched(symbol);
    const s = this.readState();
    const info = (s.symbols || []).find((x) => x.symbol === symbol);
    if (!info) throw new BrokerError(ErrorKind.NETWORK, `Símbolo ${symbol} ainda não publicado pela ponte (aguardando MT5)`);
    return { s, info };
  }

  // Garante que o EA acompanha o símbolo (arquivo lido a cada ciclo do EA).
  ensureWatched(symbol, extra = []) {
    const before = this.watch.size;
    this.watch.add(symbol);
    for (const x of extra) this.watch.add(x);
    if (this.watch.size !== before || !fs.existsSync(this.file('symbols.txt'))) {
      this.writeAtomic(this.file('symbols.txt'), `${[...this.watch].join('\n')}\n`);
    }
  }

  writeAtomic(target, content) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, content, { mode: 0o664 });
    fs.renameSync(tmp, target);
  }

  // ---------- dados de mercado ----------
  async getSymbolRules(symbol) {
    const { info } = this.symbolInfo(symbol);
    const price = info.ask || info.last || info.bid;
    return {
      symbol,
      base: symbol,
      quote: 'BRL',
      minVolume: info.volume_min,
      maxVolume: info.volume_max,
      stepSize: String(info.volume_step),
      minCost: info.volume_min * (price || 0),
      maxCost: Infinity,
      minPrice: 0,
      maxPrice: Infinity,
      tradable: !!info.trade_full,
      session: info.session_open ? 'OPEN' : 'CLOSED',
      sessionOpen: !!info.session_open,
      timezone: 'America/Sao_Paulo',
    };
  }

  isMarketOpen(rules) {
    return !!rules?.tradable && !!rules?.sessionOpen;
  }

  async getTicker(symbol) {
    const { s, info } = this.symbolInfo(symbol);
    if (!(info.bid > 0 && info.ask > 0)) {
      throw new BrokerError(ErrorKind.MARKET_CLOSED, `${symbol}: sem ofertas de compra/venda (pregão fechado ou leilão)`);
    }
    // No leilão de pré-abertura da B3 (09:45–10:00) o livro fica cruzado (bid > ask).
    // É normal do mercado, não falha da ponte: esperar como pregão fechado.
    if (info.bid > info.ask) {
      throw new BrokerError(ErrorKind.MARKET_CLOSED, `${symbol}: livro cruzado (bid ${info.bid} > ask ${info.ask}) — leilão de abertura`);
    }
    return {
      symbol, bid: info.bid, ask: info.ask, last: info.last || (info.bid + info.ask) / 2,
      high: 0, low: 0, volume: 0, quoteVolume: info.turnover || 0, ts: Number(s.ts) * 1000,
    };
  }

  async getOrderBook(symbol) {
    const { info } = this.symbolInfo(symbol);
    if (!info.asks?.length || !info.bids?.length) throw new BrokerError(ErrorKind.NETWORK, `${symbol}: livro de ofertas indisponível`);
    return { asks: info.asks, bids: info.bids, ts: this.now() };
  }

  async getCandles(symbol, timeframe, count = 200) {
    if (timeframe !== '15m') throw new BrokerError(ErrorKind.REJECTED, 'A ponte MT5 publica apenas candles de 15m');
    this.symbolInfo(symbol);
    let r;
    try {
      r = JSON.parse(fs.readFileSync(this.file(`rates_${symbol}_15m.json`), 'utf8'));
    } catch {
      throw new BrokerError(ErrorKind.NETWORK, `Candles de ${symbol} ainda não publicados pela ponte`);
    }
    if (!Array.isArray(r.t)) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Candles da ponte inválidos');
    const off = this.offsetSec || 0;
    return r.t.map((t, i) => ({ t: t - off, o: r.o[i], h: r.h[i], l: r.l[i], c: r.c[i], v: r.v[i] })).slice(-count);
  }

  // ---------- conta ----------
  async getBalance() {
    const s = this.readState();
    const out = {};
    let posValue = 0;
    for (const p of s.positions || []) {
      if (p.type !== 'BUY') continue; // bot só opera comprado
      const info = (s.symbols || []).find((x) => x.symbol === p.symbol);
      const px = info?.bid || p.price_open;
      posValue += p.volume * px;
      out[p.symbol] = { available: p.volume, onHold: 0, total: p.volume };
    }
    // Caixa = patrimônio do MT5 - valor das posições (vale para contas que
    // debitam o saldo na compra e para as que não debitam).
    const cash = Math.max(0, s.account.equity - posValue);
    out.BRL = { available: Math.max(0, Math.min(cash, s.account.margin_free)), onHold: 0, total: cash };
    return out;
  }

  async getPositions(symbols) {
    const bal = await this.getBalance();
    return symbols.map((sym) => ({ symbol: sym, quantity: bal[sym]?.total ?? 0 }));
  }

  async getOpenOrders(symbol) {
    const s = this.readState();
    return (s.orders || []).filter((o) => o.symbol === symbol).map((o) => ({
      id: String(o.ticket), externalId: o.comment || null, symbol, side: [0, 2, 4, 6].includes(o.type) ? 'BUY' : 'SELL',
      type: 'pending', qty: o.volume, cost: null, status: 'OPEN', filledQty: 0, avgPrice: null, feeBase: 0, feeQuote: 0,
    }));
  }

  async getFees() {
    return { maker: this.fee, taker: this.fee };
  }

  // ---------- ordens ----------
  resultToOrder(res, req) {
    const filled = Number(res.volume) || 0;
    let status = 'FILLED';
    if (res.retcode === RC.DONE_PARTIAL) status = 'PARTIAL';
    if (res.retcode === RC.PLACED) status = 'OPEN';
    const costs = Math.abs(Number(res.commission) || 0) + Math.abs(Number(res.fee) || 0);
    // Se a corretora não informa custo no negócio, usa a estimativa configurada.
    const feeQuote = costs > 0 ? costs : filled * Number(res.price) * this.fee;
    return {
      id: req.externalId, externalId: req.externalId, symbol: req.symbol, side: req.side, type: 'market',
      qty: filled, cost: filled * Number(res.price), status, filledQty: filled, avgPrice: Number(res.price) || null,
      feeBase: 0, feeQuote, brokerTicket: String(res.order), deal: String(res.deal),
    };
  }

  classify(res) {
    const msg = `MT5 recusou (${res.retcode}): ${res.message || ''}`.trim();
    if (res.retcode === RC.NO_MONEY) return new BrokerError(ErrorKind.INSUFFICIENT_FUNDS, msg);
    if (res.retcode === RC.MARKET_CLOSED || res.retcode === RC.TRADE_DISABLED) return new BrokerError(ErrorKind.MARKET_CLOSED, msg);
    return new BrokerError(ErrorKind.REJECTED, msg);
  }

  readResult(id) {
    try {
      return JSON.parse(fs.readFileSync(this.file('out', `${id}.json`), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new BrokerError(ErrorKind.INVALID_RESPONSE, `Resultado da ponte ilegível: ${id}`);
    }
  }

  async sendCommand(id, fields) {
    const lines = Object.entries({ id, ts: Math.floor(this.now() / 1000), ...fields }).map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, ' ')}`);
    this.writeAtomic(this.file('in', `${id}.txt`), `${lines.join('\n')}\n`);
    const deadline = Date.now() + this.orderTimeoutMs;
    while (Date.now() < deadline) {
      const r = this.readResult(id);
      if (r) return r;
      await sleep(this.pollMs);
    }
    // Sem resposta: NÃO sabemos se executou -> o OrderManager marca UNKNOWN.
    throw new BrokerError(ErrorKind.TIMEOUT, `Ponte MT5 não respondeu ao comando ${id} em ${this.orderTimeoutMs / 1000}s`);
  }

  async createOrder({ symbol, side, qty, cost, externalId }) {
    if (!externalId || !/^[A-Za-z0-9_-]{6,31}$/.test(externalId)) throw new BrokerError(ErrorKind.REJECTED, 'externalId inválido para o MT5 (máx. 31 caracteres)');
    if (this.readResult(externalId)) throw new BrokerError(ErrorKind.REJECTED, `externalId já usado: ${externalId}`);
    const rules = await this.getSymbolRules(symbol);
    if (!this.isMarketOpen(rules)) throw new BrokerError(ErrorKind.MARKET_CLOSED, `${symbol}: pregão fechado`);
    let volume = qty;
    if (side === 'BUY') {
      const t = await this.getTicker(symbol);
      volume = floorToStep(cost / t.ask, rules.stepSize);
    } else {
      volume = floorToStep(qty, rules.stepSize);
    }
    if (!(volume >= rules.minVolume)) throw new BrokerError(ErrorKind.REJECTED, `Volume ${volume} abaixo do mínimo ${rules.minVolume} de ${symbol}`);
    const res = await this.sendCommand(externalId, {
      type: 'order', symbol, side, volume, comment: externalId, allow_real: this.allowReal() ? 1 : 0,
    });
    if (!res.ok) throw this.classify(res);
    return this.resultToOrder(res, { symbol, side, externalId });
  }

  async getOrder(symbol, orderId) {
    const res = this.readResult(orderId);
    if (!res) throw new BrokerError(ErrorKind.NOT_FOUND, `Ordem ${orderId} sem resultado na ponte`);
    if (!res.ok) return { id: orderId, externalId: orderId, symbol, side: null, status: 'REJECTED', filledQty: 0, avgPrice: null, feeBase: 0, feeQuote: 0 };
    return this.resultToOrder(res, { symbol, externalId: orderId, side: null });
  }

  async findOrderByExternalId(symbol, externalId) {
    const res = this.readResult(externalId);
    if (res) {
      if (!res.ok) return { id: externalId, externalId, symbol, status: 'REJECTED', filledQty: 0, avgPrice: null, feeBase: 0, feeQuote: 0 };
      return this.resultToOrder(res, { symbol, externalId, side: null });
    }
    // O comando ainda está na fila do EA: estado indefinido, tenta de novo depois.
    if (fs.existsSync(this.file('in', `${externalId}.txt`))) {
      throw new BrokerError(ErrorKind.TIMEOUT, `Comando ${externalId} ainda não processado pela ponte`);
    }
    // Sem resultado: procura no histórico do MT5 pelo comentário.
    const found = await this.sendCommand(`${externalId.slice(0, 20)}-f${Date.now().toString(36)}`, { type: 'find', comment: externalId });
    if (found.ok) return this.resultToOrder(found, { symbol, externalId, side: null });
    return null;
  }

  async cancelOrder() {
    throw new BrokerError(ErrorKind.REJECTED, 'O bot usa apenas ordens a mercado na ponte MT5');
  }
}
