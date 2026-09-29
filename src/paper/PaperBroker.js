// Corretora simulada. Usa preços REAIS de uma fonte de dados (ex.: API
// pública do Mercado Bitcoin) e aplica as MESMAS regras da corretora real
// (mínimo por ordem, passo de quantidade, saldo). Estado fica no banco,
// então sobrevive a reinícios.
//
// Execução simulada (ordem a mercado):
//   compra: preço = ask * (1 + slippage); taxa descontada do ativo recebido
//   venda:  preço = bid * (1 - slippage); taxa descontada dos reais recebidos
import crypto from 'node:crypto';
import { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { BrokerError, ErrorKind } from '../broker/errors.js';
import { floorToStep } from '../lib/util.js';

export class PaperBroker extends BrokerAdapter {
  constructor({ db, accountId, dataSource, feePercent = 0.7, slippagePercent = 0.05, initialCapital = 20, quote = 'BRL' }) {
    super('paper');
    this.db = db;
    this.accountId = accountId;
    this.data = dataSource;
    this.fee = feePercent / 100;
    this.slippage = slippagePercent / 100;
    this.initialCapital = initialCapital;
    this.quote = quote;
    this.rulesCache = new Map();
  }

  health() {
    return this.data.health ? this.data.health() : { ok: true, circuit: 'CLOSED' };
  }

  async init() {
    const n = this.db.prepare('SELECT COUNT(*) n FROM paper_balances WHERE account_id = ?').get(this.accountId).n;
    if (n === 0) this.reset();
  }

  // Zera o ambiente simulado. Histórico de trades/ordens da conta é apagado
  // pelo chamador (Engine.resetPaper), que também registra o evento.
  reset(capital = this.initialCapital) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM paper_balances WHERE account_id = ?').run(this.accountId);
      this.db.prepare('DELETE FROM paper_orders WHERE account_id = ?').run(this.accountId);
      this.db.prepare('INSERT INTO paper_balances (account_id, asset, available, on_hold) VALUES (?, ?, ?, 0)')
        .run(this.accountId, this.quote, capital);
    })();
  }

  // ---------- dados de mercado: repassa para a fonte real ----------
  async getSymbolRules(symbol) {
    const cached = this.rulesCache.get(symbol);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.rules;
    const rules = await this.data.getSymbolRules(symbol);
    this.rulesCache.set(symbol, { rules, at: Date.now() });
    return rules;
  }
  getTicker(symbol) { return this.data.getTicker(symbol); }
  getOrderBook(symbol, limit) { return this.data.getOrderBook(symbol, limit); }
  getCandles(symbol, tf, count) { return this.data.getCandles(symbol, tf, count); }
  isMarketOpen(rules, date) { return this.data.isMarketOpen(rules, date); }
  async getFees() { return { maker: this.fee, taker: this.fee }; }

  // ---------- conta simulada ----------
  balanceRow(asset) {
    return this.db.prepare('SELECT * FROM paper_balances WHERE account_id = ? AND asset = ?').get(this.accountId, asset)
      || { available: 0, on_hold: 0 };
  }

  addBalance(asset, delta) {
    this.db.prepare(`INSERT INTO paper_balances (account_id, asset, available, on_hold) VALUES (?, ?, ?, 0)
      ON CONFLICT(account_id, asset) DO UPDATE SET available = available + excluded.available`)
      .run(this.accountId, asset, delta);
  }

  async getBalance() {
    const rows = this.db.prepare('SELECT * FROM paper_balances WHERE account_id = ?').all(this.accountId);
    const out = {};
    for (const r of rows) out[r.asset] = { available: r.available, onHold: r.on_hold, total: r.available + r.on_hold };
    return out;
  }

  async getPositions(symbols) {
    const bal = await this.getBalance();
    return symbols.map((s) => ({ symbol: s, quantity: bal[s.split('-')[0]]?.total ?? 0 }));
  }

  rowToOrder(r) {
    return {
      id: r.id, externalId: r.external_id, symbol: r.symbol, side: r.side, type: r.type, qty: r.qty, cost: r.cost,
      status: r.status, filledQty: r.filled_qty, avgPrice: r.avg_price,
      feeBase: r.fee_asset === 'BASE' ? r.fee : 0, feeQuote: r.fee_asset === 'QUOTE' ? r.fee : 0,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  async getOpenOrders(symbol) {
    // Ordens a mercado executam na hora; nunca há ordens abertas no paper.
    return this.db.prepare("SELECT * FROM paper_orders WHERE account_id = ? AND symbol = ? AND status IN ('OPEN','PARTIAL')")
      .all(this.accountId, symbol).map((r) => this.rowToOrder(r));
  }

  async getOrder(symbol, orderId) {
    const r = this.db.prepare('SELECT * FROM paper_orders WHERE account_id = ? AND id = ?').get(this.accountId, orderId);
    if (!r) throw new BrokerError(ErrorKind.NOT_FOUND, `Ordem ${orderId} não encontrada`);
    return this.rowToOrder(r);
  }

  async findOrderByExternalId(symbol, externalId) {
    const r = this.db.prepare('SELECT * FROM paper_orders WHERE account_id = ? AND external_id = ?').get(this.accountId, externalId);
    return r ? this.rowToOrder(r) : null;
  }

  async cancelOrder(symbol, orderId) {
    return this.getOrder(symbol, orderId);
  }

  async createOrder({ symbol, side, type = 'market', qty, cost, externalId }) {
    if (type !== 'market') throw new BrokerError(ErrorKind.REJECTED, 'Paper trading suporta apenas ordens a mercado');
    if (externalId && (await this.findOrderByExternalId(symbol, externalId))) {
      throw new BrokerError(ErrorKind.REJECTED, `externalId duplicado: ${externalId}`);
    }
    const rules = await this.getSymbolRules(symbol);
    if (!this.isMarketOpen(rules)) throw new BrokerError(ErrorKind.MARKET_CLOSED, 'Mercado fechado');
    const ticker = await this.getTicker(symbol);
    const { base, quote } = rules;
    const now = Date.now();
    const id = `paper-${crypto.randomUUID()}`;

    let filledQty;
    let avgPrice;
    let fee;
    let feeAsset;
    let orderCost = cost ?? null;

    if (side === 'BUY') {
      if (!cost || cost <= 0) throw new BrokerError(ErrorKind.REJECTED, 'Compra a mercado exige cost (valor em reais)');
      if (cost < rules.minCost) throw new BrokerError(ErrorKind.REJECTED, `Valor abaixo do mínimo (${rules.minCost} ${quote})`);
      const cash = this.balanceRow(quote).available;
      if (cost > cash + 1e-9) throw new BrokerError(ErrorKind.INSUFFICIENT_FUNDS, `Saldo insuficiente: ${cash.toFixed(2)} ${quote}`);
      avgPrice = ticker.ask * (1 + this.slippage);
      filledQty = floorToStep(cost / avgPrice, rules.stepSize);
      if (filledQty < rules.minVolume) throw new BrokerError(ErrorKind.REJECTED, `Quantidade abaixo do mínimo (${rules.minVolume} ${base})`);
      orderCost = filledQty * avgPrice;
      fee = filledQty * this.fee;
      feeAsset = 'BASE';
      this.db.transaction(() => {
        this.addBalance(quote, -orderCost);
        this.addBalance(base, filledQty - fee);
      })();
    } else {
      const q = floorToStep(qty, rules.stepSize);
      if (!q || q < rules.minVolume) throw new BrokerError(ErrorKind.REJECTED, `Quantidade abaixo do mínimo (${rules.minVolume} ${base})`);
      const held = this.balanceRow(base).available;
      if (q > held + 1e-12) throw new BrokerError(ErrorKind.INSUFFICIENT_FUNDS, `Saldo insuficiente de ${base}: ${held}`);
      avgPrice = ticker.bid * (1 - this.slippage);
      if (q * avgPrice < rules.minCost) throw new BrokerError(ErrorKind.REJECTED, `Valor abaixo do mínimo (${rules.minCost} ${quote})`);
      filledQty = q;
      const gross = q * avgPrice;
      fee = gross * this.fee;
      feeAsset = 'QUOTE';
      orderCost = gross;
      this.db.transaction(() => {
        this.addBalance(base, -q);
        this.addBalance(quote, gross - fee);
      })();
    }

    this.db.prepare(`INSERT INTO paper_orders (id, account_id, external_id, symbol, side, type, qty, cost, filled_qty,
        avg_price, fee, fee_asset, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'FILLED', ?, ?)`)
      .run(id, this.accountId, externalId || null, symbol, side, type, side === 'SELL' ? filledQty : null, orderCost,
        filledQty, avgPrice, fee, feeAsset, now, now);
    return this.getOrder(symbol, id);
  }
}
