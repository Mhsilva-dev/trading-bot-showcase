// Configuração central. Só o backend lê este módulo — nada daqui vai
// para o frontend sem passar por publicConfig().
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const env = process.env;

function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function num(v, def) {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido na configuração: "${v}"`);
  return n;
}

function dbPath(url) {
  const raw = (url || 'file:./data/trading.db').replace(/^file:/, '');
  if (raw === ':memory:') return raw;
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
}

export function loadConfig(overrides = {}) {
  const e = { ...env, ...overrides };
  const mode = (e.TRADING_MODE || 'paper').toLowerCase();
  if (!['paper', 'live'].includes(mode)) throw new Error(`TRADING_MODE inválido: ${mode}`);

  return {
    nodeEnv: e.NODE_ENV || 'development',
    timezone: e.TIMEZONE || 'America/Sao_Paulo',

    tradingMode: mode,
    tradingEnabled: bool(e.TRADING_ENABLED, false),
    liveConfirm: bool(e.LIVE_TRADING_CONFIRM, false),

    broker: {
      name: e.BROKER || 'mercadobitcoin',
      apiKey: e.API_KEY || '',
      apiSecret: e.API_SECRET || '',
      baseUrl: e.API_BASE_URL || 'https://api.mercadobitcoin.net/api/v4',
      accountId: e.BROKER_ACCOUNT_ID || '',
    },

    // Valores iniciais das configurações editáveis (tabela settings sobrepõe)
    defaults: {
      symbol: e.SYMBOL || 'BTC-BRL',
      timeframe: e.TIMEFRAME || '15m',
      strategy: e.STRATEGY || 'ema_rsi',
      maxPositionPercent: num(e.MAX_POSITION_PERCENT, 95),
      maxOrderValue: num(e.MAX_ORDER_VALUE, 20),
      maxDailyLoss: num(e.MAX_DAILY_LOSS, 1),
      maxDailyTrades: num(e.MAX_DAILY_TRADES, 4),
      stopLossPercent: num(e.STOP_LOSS_PERCENT, 2),
      takeProfitPercent: num(e.TAKE_PROFIT_PERCENT, 3),
      maxSpreadPercent: num(e.MAX_SPREAD_PERCENT, 0.5),
      min24hVolume: num(e.MIN_24H_VOLUME, 100000),
      stopManageExits: bool(e.STOP_MANAGE_EXITS, true),
    },

    initialCapital: num(e.INITIAL_CAPITAL, 20),
    paperFeePercent: num(e.PAPER_FEE_PERCENT, 0.7),
    paperSlippagePercent: num(e.PAPER_SLIPPAGE_PERCENT, 0.05),

    priceCheckIntervalSec: num(e.PRICE_CHECK_INTERVAL_SECONDS, 15),
    reconcileIntervalSec: num(e.RECONCILE_INTERVAL_SECONDS, 300),
    maxDataAgeSec: num(e.MAX_DATA_AGE_SECONDS, 90),

    databasePath: dbPath(e.DATABASE_URL),
    // Chave do cofre de credenciais cadastradas pelo painel (64 hex).
    credentialsKey: e.CREDENTIALS_KEY || '',

    // MetaTrader 5 (XP) via Wine
    mt5: {
      home: e.MT5_HOME || '/var/lib/mt5',
      bridgeDir: e.MT5_BRIDGE_DIR || '',
      // Custo estimado por execução (%): emolumentos B3 + corretagem. Confirme na sua tabela XP.
      feePercent: num(e.MT5_FEE_PERCENT, 0.05),
      // Janela em que o MT5 fica ligado (horário de Brasília, dias úteis)
      startTime: e.MT5_START_TIME || '09:30',
      stopTime: e.MT5_STOP_TIME || '18:15',
      alwaysOn: bool(e.MT5_ALWAYS_ON, false),
      display: e.MT5_DISPLAY || ':90',
    },

    dashboard: {
      host: e.DASHBOARD_HOST || '127.0.0.1',
      port: num(e.DASHBOARD_PORT, 3010),
      sessionSecret: e.JWT_SECRET || e.SESSION_SECRET || '',
      cookieSecure: bool(e.COOKIE_SECURE, false),
    },
  };
}

// Por que o live está (ou não) liberado. Usado pelo Risk Manager e pelo painel.
export function liveBlockReason(config) {
  if (config.tradingMode !== 'live') return 'TRADING_MODE não é live';
  if (!config.liveConfirm) return 'LIVE_TRADING_CONFIRM=true não configurado';
  if (!config.broker.apiKey || !config.broker.apiSecret) return 'API_KEY/API_SECRET ausentes';
  return null;
}

export const config = loadConfig();
