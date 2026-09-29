// npm run user:delete -- <usuario>   — remove o usuário e derruba as sessões dele.
import { config } from '../config/index.js';
import { openDatabase } from '../database/db.js';
import { Repo } from '../database/repo.js';

const username = process.argv[2];
const db = openDatabase(config.databasePath);
const repo = new Repo(db);
if (!username || !repo.getUser(username)) {
  console.error(`Usuário não encontrado. Existentes: ${repo.listUsers().map((u) => u.username).join(', ')}`);
  process.exit(1);
}
if (repo.countUsers() <= 1) {
  console.error('Não é possível remover o último usuário (você ficaria sem acesso ao painel).');
  process.exit(1);
}
repo.deleteUser(username);
// Sessões guardam o usuário em JSON: remove as dele.
const n = db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.user.username') = ?").run(username).changes;
repo.addEvent({ category: 'SECURITY', event: 'USER_DELETED', severity: 'WARNING', message: `Usuário "${username}" removido via CLI (${n} sessão(ões) encerrada(s))` });
console.log(`Usuário "${username}" removido; ${n} sessão(ões) encerrada(s).`);
