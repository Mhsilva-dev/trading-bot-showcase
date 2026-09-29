// Contas e corretoras. Cada conta roda seu próprio Engine, com saldo,
// ordens e histórico separados.
//   paper -> simulação com preços reais do Mercado Bitcoin (sempre ativa)
//   xp    -> XP Investimentos via MetaTrader 5 (conta DEMO); ativa quando
//            há credenciais cadastradas no painel (tela Conexões)
//   live  -> Mercado Bitcoin real; só com TRADING_MODE=live
import path from 'node:path';
import { MercadoBitcoinBroker } from '../broker/MercadoBitcoinBroker.js';
import { MT5BridgeBroker } from '../broker/MT5BridgeBroker.js';
import { PaperBroker } from '../paper/PaperBroker.js';
import { mt5ShouldRun } from '../mt5/schedule.js';

export const PAPER_ACCOUNT = { id: 'paper', name: 'Paper Trading', broker: 'paper', mode: 'paper' };
export const XP_ACCOUNT = { id: 'xp', name: 'XP Investimentos (MT5)', broker: 'xp_mt5', mode: 'demo' };
export const LIVE_ACCOUNT = { id: 'live', name: 'Mercado Bitcoin (real)', broker: 'mercadobitcoin', mode: 'live' };
export const ACCOUNTS = [PAPER_ACCOUNT, XP_ACCOUNT, LIVE_ACCOUNT];
export const ACCOUNT_IDS = ACCOUNTS.map((a) => a.id);

// Padrões da conta XP (B3). Ações fracionárias (final F) permitem comprar
// a partir de 1 ação — necessário com capital pequeno.
export const XP_DEFAULT_SETTINGS = { symbol: 'PETR4F', timeframe: '15m', min24hVolume: 0, maxSpreadPercent: 0.5 };
export const B3_WATCHLIST = ['VALE3F', 'PETR4F', 'ITUB4F', 'BBDC4F', 'B3SA3F', 'BBAS3F', 'ITSA4F', 'ABEV3F', 'CMIG4F', 'MGLU3F'];

export function registerAccounts(repo) {
  for (const a of ACCOUNTS) repo.ensureAccount(a);
  const cur = repo.getSettings('xp');
  const missing = Object.fromEntries(Object.entries(XP_DEFAULT_SETTINGS).filter(([k]) => cur[k] === undefined));
  if (Object.keys(missing).length) repo.setSettings('xp', missing);
}

export function mt5BridgeDir(config) {
  return config.mt5?.bridgeDir || path.join(config.mt5?.home || '/var/lib/mt5', '.wine/drive_c/Program Files/MetaTrader 5/MQL5/Files/bridge');
}

export function createBroker(account, { config, db, repo }) {
  if (account.mode === 'paper') {
    // Dados reais e públicos do Mercado Bitcoin (sem credenciais) + execução simulada.
    const dataSource = new MercadoBitcoinBroker({ baseUrl: config.broker.baseUrl });
    return new PaperBroker({
      db, accountId: account.id, dataSource,
      feePercent: config.paperFeePercent, slippagePercent: config.paperSlippagePercent, initialCapital: config.initialCapital,
    });
  }
  if (account.id === 'xp') {
    return new MT5BridgeBroker({
      bridgeDir: mt5BridgeDir(config),
      feePercent: config.mt5.feePercent,
      // Ambiente esperado vem do cadastro em Conexões; real só com live liberado.
      expectedEnvironment: () => repo?.getCredential('xp_mt5')?.environment || null,
      allowReal: () => config.tradingMode === 'live' && config.liveConfirm,
      scheduledOn: () => mt5ShouldRun(config.mt5),
    });
  }
  if (config.broker.name !== 'mercadobitcoin') throw new Error(`Corretora não suportada: ${config.broker.name}`);
  return new MercadoBitcoinBroker({
    apiKey: config.broker.apiKey, apiSecret: config.broker.apiSecret, baseUrl: config.broker.baseUrl, accountId: config.broker.accountId,
  });
}
