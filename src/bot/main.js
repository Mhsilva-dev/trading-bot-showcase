// Processo do bot (PM2: trading-bot). Independente do painel: se o painel
// cair, o bot continua; comandos chegam pela tabela `commands` no banco.
import { config, liveBlockReason } from '../config/index.js';
import { openDatabase } from '../database/db.js';
import { Repo } from '../database/repo.js';
import { Logger, registerSecrets } from '../monitoring/logger.js';
import { Engine } from './Engine.js';
import { registerAccounts, createBroker, PAPER_ACCOUNT, XP_ACCOUNT, LIVE_ACCOUNT } from './accounts.js';
import { sleep } from '../lib/util.js';

registerSecrets([config.broker.apiKey, config.broker.apiSecret, config.dashboard.sessionSecret, config.credentialsKey]);

const db = openDatabase(config.databasePath);
const repo = new Repo(db);
const log = new Logger({ repo });
config.liveBlockReason = liveBlockReason(config);

registerAccounts(repo);

const engines = new Map();
const mk = (account) => new Engine({ account, broker: createBroker(account, { config, db, repo }), repo, db, config, log: log.child(account.id) });
engines.set(PAPER_ACCOUNT.id, mk(PAPER_ACCOUNT));
// XP (MT5): fica ociosa até existir cadastro em Conexões e o MT5 estar ligado.
engines.set(XP_ACCOUNT.id, mk(XP_ACCOUNT));

if (config.tradingMode === 'live') {
  engines.set(LIVE_ACCOUNT.id, mk(LIVE_ACCOUNT));
  if (config.liveBlockReason) log.child(LIVE_ACCOUNT.id).critical('SECURITY', 'LIVE_BLOCKED', `LIVE TRADING BLOCKED: ${config.liveBlockReason}`);
} else {
  repo.saveState(LIVE_ACCOUNT.id, {
    status: 'DISABLED', reason: `LIVE TRADING BLOCKED: ${config.liveBlockReason}`, riskStatus: 'BLOCKED', riskReason: config.liveBlockReason,
    brokerStatus: 'DISCONNECTED', data: { mode: 'live', broker: 'mercadobitcoin' },
  });
}

log.info('SYSTEM', 'BOT_BOOT', `Bot iniciado — modo ${config.tradingMode}, TRADING_ENABLED=${config.tradingEnabled}, contas: ${[...engines.keys()].join(', ')}`);
if (!config.tradingEnabled) log.warn('SYSTEM', 'KILL_SWITCH', 'TRADING_ENABLED=false: nenhuma ordem será enviada');

let running = true;
const wake = new Map(); // acorda o loop da conta após um comando

async function loop(engine) {
  await engine.init();
  while (running) {
    await engine.tick();
    await new Promise((resolve) => {
      const t = setTimeout(resolve, config.priceCheckIntervalSec * 1000);
      wake.set(engine.account.id, () => { clearTimeout(t); resolve(); });
    });
  }
}

async function commandLoop() {
  while (running) {
    try {
      for (const cmd of repo.pendingCommands()) {
        const engine = engines.get(cmd.account_id);
        if (!engine) {
          repo.finishCommand(cmd.id, false, { error: 'Conta não está ativa neste processo' });
          continue;
        }
        try {
          const res = await engine.handleCommand(cmd);
          repo.finishCommand(cmd.id, true, res);
        } catch (e) {
          repo.finishCommand(cmd.id, false, { error: e.message });
          log.child(cmd.account_id).warn('SYSTEM', 'COMMAND_FAILED', `Comando ${cmd.command} falhou: ${e.message}`);
        }
        wake.get(cmd.account_id)?.();
      }
    } catch (e) {
      process.stderr.write(`falha no loop de comandos: ${e.message}\n`);
    }
    await sleep(1000);
  }
}

async function shutdown(sig) {
  if (!running) return;
  running = false;
  log.warn('SYSTEM', 'BOT_SHUTDOWN', `Bot encerrando (${sig}). Estado será reverificado na próxima inicialização.`);
  for (const w of wake.values()) w();
  // Espera ciclos em andamento terminarem (ordem em envio, por exemplo).
  await Promise.race([Promise.all([...engines.values()].map((e) => e.lock)), sleep(15_000)]);
  for (const e of engines.values()) {
    const prev = repo.getState(e.account.id) || {};
    repo.saveState(e.account.id, {
      status: 'OFFLINE', reason: 'Processo do bot encerrado', riskStatus: prev.risk_status, riskReason: prev.risk_reason,
      brokerStatus: prev.broker_status, lastAnalysisAt: prev.last_analysis_at, lastSignal: prev.last_signal, lastPrice: prev.last_price, data: prev.data,
    });
  }
  db.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.critical('SYSTEM', 'UNHANDLED', `Erro não tratado: ${e?.message || e}`));

commandLoop();
for (const e of engines.values()) loop(e).catch((err) => log.critical('SYSTEM', 'LOOP_CRASH', `Loop da conta ${e.account.id} falhou: ${err.message}`));
