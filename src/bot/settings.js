// Configurações editáveis por conta: valor salvo no banco (painel) ou, se
// não houver, o padrão vindo do .env. Usado pelo bot e pela API.
import { STRATEGIES } from './strategy/index.js';

export const SETTINGS_KEYS = ['symbol', 'timeframe', 'strategy', 'strategyParams', 'maxPositionPercent', 'maxOrderValue',
  'maxDailyLoss', 'maxDailyTrades', 'stopLossPercent', 'takeProfitPercent', 'maxSpreadPercent', 'min24hVolume', 'stopManageExits'];

export function effectiveSettings(repo, defaults, accountId) {
  const stored = repo.getSettings(accountId);
  const s = {};
  for (const k of SETTINGS_KEYS) s[k] = stored[k] ?? defaults[k];
  const def = STRATEGIES[s.strategy] || STRATEGIES.ema_rsi;
  s.strategyParams = { ...def.defaults, ...(stored.strategyParams || {}) };
  return s;
}
