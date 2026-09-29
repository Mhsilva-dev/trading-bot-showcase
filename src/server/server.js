// Processo do painel (PM2: trading-dashboard): API + WebSocket + frontend.
// Não envia ordens: comandos vão para a fila `commands`, lida pelo bot.
import http from 'node:http';
import { config, liveBlockReason } from '../config/index.js';
import { openDatabase } from '../database/db.js';
import { Repo } from '../database/repo.js';
import { Logger, registerSecrets } from '../monitoring/logger.js';
import { registerAccounts } from '../bot/accounts.js';
import { MercadoBitcoinBroker } from '../broker/MercadoBitcoinBroker.js';
import { createApp } from './app.js';
import { attachRealtime } from './realtime.js';

registerSecrets([config.broker.apiKey, config.broker.apiSecret, config.dashboard.sessionSecret, config.credentialsKey]);
config.liveBlockReason = liveBlockReason(config);

const db = openDatabase(config.databasePath);
const repo = new Repo(db);
const log = new Logger({ repo });
registerAccounts(repo);

// Dados públicos (sem credenciais) só para o backtest.
const marketData = new MercadoBitcoinBroker({ baseUrl: config.broker.baseUrl });

const { app, sessionMiddleware } = createApp({ db, repo, config, log, marketData });
const server = http.createServer(app);
const rt = attachRealtime({ server, sessionMiddleware, repo, config, log });

if (repo.countUsers() === 0) {
  log.warn('SECURITY', 'NO_USERS', 'Nenhum usuário cadastrado. Crie com: npm run user:create -- <usuario>');
}

server.listen(config.dashboard.port, config.dashboard.host, () => {
  log.info('SYSTEM', 'DASHBOARD_START', `Painel em http://${config.dashboard.host}:${config.dashboard.port}`);
});

function shutdown() {
  rt.close();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
