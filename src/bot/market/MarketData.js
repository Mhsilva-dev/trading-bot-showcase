// Coleta e valida dados de mercado. Regras de segurança:
// - só entrega candles FECHADOS para a estratégia (o candle em formação muda);
// - marca a hora de cada leitura para o Risk Manager recusar dados velhos;
// - valida coerência básica (bid <= ask, preços > 0).
import { TIMEFRAME_SECONDS } from '../../lib/util.js';
import { BrokerError, ErrorKind } from '../../broker/errors.js';

export class MarketData {
  constructor({ broker, repo, symbol, timeframe, now = () => Date.now() }) {
    this.broker = broker;
    this.repo = repo;
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.tfSec = TIMEFRAME_SECONDS[timeframe];
    if (!this.tfSec) throw new Error(`Timeframe não suportado: ${timeframe}`);
    this.now = now;
    this.rulesCache = null;
    this.lastTicker = null;
    this.candles = [];
    this.candlesFetchedFor = null;
  }

  async rules() {
    if (!this.rulesCache || this.now() - this.rulesCache.at > 3_600_000) {
      this.rulesCache = { value: await this.broker.getSymbolRules(this.symbol), at: this.now() };
    }
    return this.rulesCache.value;
  }

  async ticker() {
    const t = await this.broker.getTicker(this.symbol);
    if (!(t.bid > 0 && t.ask > 0 && t.last > 0)) throw new BrokerError(ErrorKind.INVALID_RESPONSE, 'Ticker com preço zerado/negativo');
    if (t.bid > t.ask) throw new BrokerError(ErrorKind.INVALID_RESPONSE, `Ticker incoerente: bid ${t.bid} > ask ${t.ask}`);
    this.lastTicker = { ...t, fetchedAt: this.now() };
    return this.lastTicker;
  }

  // Início (em segundos) do último candle já fechado.
  lastClosedStart(nowSec = Math.floor(this.now() / 1000)) {
    return Math.floor(nowSec / this.tfSec) * this.tfSec - this.tfSec;
  }

  // Retorna { candles, isNew }. isNew = surgiu um candle fechado desde a última chamada.
  async closedCandles(count = 200) {
    const target = this.lastClosedStart();
    if (this.candlesFetchedFor === target && this.candles.length) return { candles: this.candles, isNew: false };
    const raw = await this.broker.getCandles(this.symbol, this.timeframe, count + 2);
    const nowSec = Math.floor(this.now() / 1000);
    const closed = raw.filter((k) => k.t + this.tfSec <= nowSec).sort((a, b) => a.t - b.t);
    for (const k of closed) {
      if (!(k.h >= k.l && k.c > 0 && k.o > 0)) throw new BrokerError(ErrorKind.INVALID_RESPONSE, `Candle inválido em ${k.t}`);
    }
    if (this.repo && raw.length) this.repo.saveCandles(this.symbol, this.timeframe, raw);
    const newest = closed.at(-1)?.t;
    // A corretora pode demorar alguns segundos para publicar o candle recém-fechado.
    const isNew = newest !== undefined && newest !== this.candles.at(-1)?.t;
    if (newest === target) this.candlesFetchedFor = target;
    this.candles = closed.slice(-count);
    return { candles: this.candles, isNew };
  }

  tickerAgeSec() {
    return this.lastTicker ? (this.now() - this.lastTicker.fetchedAt) / 1000 : Infinity;
  }
}
