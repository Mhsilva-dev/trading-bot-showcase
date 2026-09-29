// Registro de estratégias. Para adicionar uma nova: implemente
// { name, label, params, minCandles(), evaluate(candles, ctx), indicatorSeries(candles) }
// e registre aqui.
import { EmaRsiStrategy, EMA_RSI_DEFAULTS, EMA_RSI_PARAMS_DOC } from './EmaRsiStrategy.js';

export const STRATEGIES = {
  ema_rsi: { label: 'EMA Cross + RSI', create: (p) => new EmaRsiStrategy(p), defaults: EMA_RSI_DEFAULTS, docs: EMA_RSI_PARAMS_DOC },
};

export function createStrategy(name, params = {}) {
  const def = STRATEGIES[name];
  if (!def) throw new Error(`Estratégia desconhecida: ${name}`);
  return def.create(params);
}
