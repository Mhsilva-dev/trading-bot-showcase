// npm run bot:stop [-- --emergency] [-- --account=live]
// Grava o controle direto no banco: vale na hora, mesmo com o painel fora.
import { config } from '../config/index.js';
import { openDatabase } from '../database/db.js';
import { Repo } from '../database/repo.js';

const args = process.argv.slice(2);
const emergency = args.includes('--emergency');
const only = args.find((a) => a.startsWith('--account='))?.split('=')[1];
const repo = new Repo(openDatabase(config.databasePath));

for (const a of repo.listAccounts()) {
  if (only && a.id !== only) continue;
  repo.setControl(a.id, emergency ? { desired: 'STOPPED', emergency: true } : { desired: 'STOPPED' }, 'cli');
  repo.addCommand(a.id, emergency ? 'emergency_stop' : 'stop', null, 'cli');
  repo.addEvent({ accountId: a.id, category: 'SYSTEM', event: emergency ? 'EMERGENCY_STOP' : 'BOT_STOPPED', severity: emergency ? 'CRITICAL' : 'WARNING', message: `${emergency ? 'EMERGENCY STOP' : 'Parada'} via CLI`, alert: true });
  console.log(`[${a.id}] ${emergency ? 'EMERGENCY STOP' : 'STOPPED'}`);
}
console.log(emergency ? 'Nenhuma ordem será enviada até liberar a emergência no painel.' : 'Novas entradas bloqueadas.');
