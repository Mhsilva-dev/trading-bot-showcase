// Contrato que TODA corretora precisa implementar. O bot só conhece esta
// interface — trocar de corretora = trocar o adapter.
//
// Tipos normalizados (independentes da corretora):
//
// SymbolRules { symbol, base, quote, minVolume, maxVolume, minCost, maxCost,
//               minPrice, maxPrice, stepSize (string), tradable, session, timezone }
// Ticker      { symbol, bid, ask, last, high, low, volume, quoteVolume, ts (ms) }
// OrderBook   { bids: [[price, qty]], asks: [[price, qty]], ts }
// Candle      { t (seg, início do candle), o, h, l, c, v }
// Balances    { [asset]: { available, onHold, total } }
// Order       { id, externalId, symbol, side: BUY|SELL, type, qty, cost,
//               status: OPEN|PARTIAL|FILLED|CANCELED|REJECTED,
//               filledQty, avgPrice, feeBase, feeQuote, createdAt, updatedAt }
// Position    { symbol, quantity, averagePrice }

export class BrokerAdapter {
  constructor(name) {
    this.name = name;
  }

  /** Conecta/autentica. Deve falhar alto se credenciais forem inválidas. */
  async init() {}

  /** Estado da conexão para o health check: { ok, circuit, message } */
  health() { return { ok: true, circuit: 'CLOSED' }; }

  async getSymbolRules(_symbol) { throw new Error('não implementado'); }
  async getTicker(_symbol) { throw new Error('não implementado'); }
  async getOrderBook(_symbol, _limit) { throw new Error('não implementado'); }
  async getCandles(_symbol, _timeframe, _count) { throw new Error('não implementado'); }
  async getBalance() { throw new Error('não implementado'); }
  async getOpenOrders(_symbol) { throw new Error('não implementado'); }
  async getPositions(_symbols) { throw new Error('não implementado'); }
  /** { symbol, side, type:'market', qty? , cost?, externalId } -> Order */
  async createOrder(_req) { throw new Error('não implementado'); }
  async cancelOrder(_symbol, _orderId) { throw new Error('não implementado'); }
  async getOrder(_symbol, _orderId) { throw new Error('não implementado'); }
  /** Procura ordem pelo id do cliente — base da proteção contra duplicidade. */
  async findOrderByExternalId(_symbol, _externalId, _sinceSec) { throw new Error('não implementado'); }
  /** { maker, taker } em fração (0.007 = 0,7%) */
  async getFees(_symbol) { throw new Error('não implementado'); }
  /** true se o mercado aceita ordens agora. */
  isMarketOpen(rules, _date = new Date()) { return !!rules?.tradable; }
}
