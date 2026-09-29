// npm run bot:status — resumo das contas direto do banco.
import { config, liveBlockReason } from '../config/index.js';
import { openDatabase } from '../database/db.js';
import { Repo } from '../database/repo.js';
import { accountStatus } from '../api/routes/bot.js';

config.liveBlockReason = liveBlockReason(config);
const repo = new Repo(openDatabase(config.databasePath));
const brl = (v) => (v === null || v === undefined ? '—' : `R$${Number(v).toFixed(2)}`);

console.log(`TRADING_MODE=${config.tradingMode}  TRADING_ENABLED=${config.tradingEnabled}`);
for (const a of repo.listAccounts()) {
  const s = accountStatus(repo, config, a.id);
  console.log(`\n[${a.id.toUpperCase()}] ${a.name}`);
  console.log(`  status:     ${s.status}${s.reason ? ` — ${s.reason}` : ''}`);
  console.log(`  controle:   ${s.control.desired}${s.control.emergency ? ' + EMERGENCY' : ''}`);
  console.log(`  risco:      ${s.riskStatus}${s.riskReason ? ` — ${s.riskReason}` : ''}`);
  console.log(`  saldo:      ${brl(s.balance)}   patrimônio: ${brl(s.equity)}   P/L hoje: ${brl(s.dailyPnL)}   P/L total: ${brl(s.totalPnL)}`);
  if (s.position) console.log(`  posição:    ${s.position.quantity} ${s.position.symbol} @ ${s.position.average_price} (P/L aberto ${brl(s.position.unrealized_profit)})`);
  console.log(`  último sinal: ${s.lastSignal ? `${s.lastSignal.signal} — ${s.lastSignal.reason}` : '—'}`);
  console.log(`  heartbeat:  ${s.heartbeatAt || '—'}`);
}
