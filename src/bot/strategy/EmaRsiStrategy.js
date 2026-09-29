// Estratégia "EMA Cross + RSI" (seguidora de tendência, só compra — spot).
//
// Regras (avaliadas SOMENTE no último candle FECHADO, sem olhar o futuro):
//   BUY  quando a EMA rápida cruza PARA CIMA a EMA lenta no candle atual,
//        o RSI está abaixo de rsiBuyMax (evita comprar esticado) e,
//        se trendPeriod > 0, o fechamento está acima da EMA de tendência.
//   SELL quando a EMA rápida cruza PARA BAIXO a EMA lenta
//        ou o RSI passa de rsiExit (sobrecompra). Com signalExit = 0 a
//        estratégia nunca vende: a saída fica só com o stop-loss e o
//        take-profit (no backtest de 180 dias, a venda por sinal era a
//        maior causa de perda — saía cedo e pagava taxa de ida e volta).
//   HOLD nos demais casos.
//
// Stop-loss e take-profit NÃO são responsabilidade da estratégia — ficam
// com o Risk Manager / Engine, que valem para qualquer estratégia.
//
// `confidence` é só uma medida de quão "folgadas" estão as condições
// (0..1). NÃO é probabilidade de lucro.
import { ema, rsi } from './indicators.js';

export const EMA_RSI_DEFAULTS = {
  fastPeriod: 9,
  slowPeriod: 21,
  rsiPeriod: 14,
  rsiBuyMax: 70,
  rsiExit: 80,
  trendPeriod: 50,
  signalExit: 1,
};

export const EMA_RSI_PARAMS_DOC = {
  fastPeriod: 'Período da EMA rápida (candles)',
  slowPeriod: 'Período da EMA lenta (candles)',
  rsiPeriod: 'Período do RSI',
  rsiBuyMax: 'Não compra se o RSI estiver acima deste valor',
  rsiExit: 'Vende se o RSI passar deste valor',
  trendPeriod: 'EMA de tendência: só compra com preço acima dela (0 desliga)',
  signalExit: 'Vende por sinal (1) ou só no stop/alvo (0)',
};

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));

export class EmaRsiStrategy {
  constructor(params = {}) {
    this.name = 'ema_rsi';
    this.label = 'EMA Cross + RSI';
    this.params = { ...EMA_RSI_DEFAULTS, ...params };
    const p = this.params;
    if (!(p.fastPeriod >= 2 && p.slowPeriod > p.fastPeriod)) throw new Error('fastPeriod deve ser >= 2 e menor que slowPeriod');
    if (!(p.rsiPeriod >= 2)) throw new Error('rsiPeriod deve ser >= 2');
    if (p.signalExit !== 0 && p.signalExit !== 1) throw new Error('signalExit deve ser 0 ou 1');
  }

  minCandles() {
    return Math.max(this.params.slowPeriod, this.params.trendPeriod || 0, this.params.rsiPeriod) + 2;
  }

  // Séries completas para desenhar no gráfico do painel.
  indicatorSeries(candles) {
    const closes = candles.map((c) => c.c);
    const p = this.params;
    return {
      emaFast: ema(closes, p.fastPeriod),
      emaSlow: ema(closes, p.slowPeriod),
      emaTrend: p.trendPeriod ? ema(closes, p.trendPeriod) : null,
      rsi: rsi(closes, p.rsiPeriod),
    };
  }

  /**
   * @param candles candles FECHADOS, do mais antigo para o mais novo
   * @param ctx { hasPosition }
   * @returns { signal, confidence, price, reason, indicators }
   */
  evaluate(candles, ctx = {}) {
    const p = this.params;
    if (!candles || candles.length < this.minCandles()) {
      return { signal: 'HOLD', confidence: 0, price: candles?.at(-1)?.c ?? null, reason: `Dados insuficientes (${candles?.length || 0}/${this.minCandles()} candles)`, indicators: {} };
    }
    const s = this.indicatorSeries(candles);
    const i = candles.length - 1;
    const price = candles[i].c;
    const f0 = s.emaFast[i - 1]; const f1 = s.emaFast[i];
    const l0 = s.emaSlow[i - 1]; const l1 = s.emaSlow[i];
    const r = s.rsi[i];
    const trend = s.emaTrend ? s.emaTrend[i] : null;
    const indicators = { emaFast: f1, emaSlow: l1, rsi: r, emaTrend: trend };

    const crossUp = f0 <= l0 && f1 > l1;
    const crossDown = f0 >= l0 && f1 < l1;

    if (ctx.hasPosition) {
      if (!p.signalExit) return { signal: 'HOLD', confidence: 0, price, reason: 'Posição aberta; saída só pelo stop ou pelo alvo', indicators };
      if (crossDown) return { signal: 'SELL', confidence: clamp((l1 - f1) / l1 * 200 + 0.5), price, reason: `EMA${p.fastPeriod} cruzou abaixo da EMA${p.slowPeriod}`, indicators };
      if (r > p.rsiExit) return { signal: 'SELL', confidence: clamp((r - p.rsiExit) / (100 - p.rsiExit) + 0.5), price, reason: `RSI ${r.toFixed(1)} acima de ${p.rsiExit} (sobrecompra)`, indicators };
      return { signal: 'HOLD', confidence: 0, price, reason: 'Posição aberta; condições de saída não atendidas', indicators };
    }

    if (crossUp) {
      if (r >= p.rsiBuyMax) return { signal: 'HOLD', confidence: 0, price, reason: `Cruzamento de alta, mas RSI ${r.toFixed(1)} >= ${p.rsiBuyMax}`, indicators };
      if (trend !== null && price <= trend) return { signal: 'HOLD', confidence: 0, price, reason: `Cruzamento de alta, mas preço abaixo da EMA${p.trendPeriod} (tendência)`, indicators };
      const sep = (f1 - l1) / l1 * 100;
      const conf = clamp(0.5 + sep * 2 + (p.rsiBuyMax - r) / 200);
      return { signal: 'BUY', confidence: Number(conf.toFixed(2)), price, reason: `EMA${p.fastPeriod} cruzou acima da EMA${p.slowPeriod}; RSI ${r.toFixed(1)}${trend ? `; acima da EMA${p.trendPeriod}` : ''}`, indicators };
    }
    return { signal: 'HOLD', confidence: 0, price, reason: 'Sem cruzamento de médias', indicators };
  }
}
