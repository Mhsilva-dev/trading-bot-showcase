// Cria/atualiza usuário do painel.
//   npm run user:create -- admin            (pede a senha sem mostrar)
//   TB_PASSWORD=... npm run user:create -- admin
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';
import { openDatabase } from '../database/db.js';
import { Repo } from '../database/repo.js';

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

const username = process.argv.slice(2).find((a) => !a.startsWith('--'));
// --senha-fraca: aceita senha curta (mín. 6) por decisão explícita do dono; fica registrado.
const allowWeak = process.argv.includes('--senha-fraca');
if (!username || !/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
  console.error('Uso: npm run user:create -- <usuario>   (3-32 caracteres: letras, números, _ . -)');
  process.exit(1);
}
const minLen = allowWeak ? 6 : 12;
const password = process.env.TB_PASSWORD || await askHidden(`Senha (mín. ${minLen} caracteres): `);
if (!password || password.length < minLen) {
  console.error(`Senha muito curta: use pelo menos ${minLen} caracteres.`);
  process.exit(1);
}
if (password.length < 12) console.warn('AVISO: senha curta. O login trava por 1h após 5 erros, mas troque por uma senha forte assim que possível.');
const repo = new Repo(openDatabase(config.databasePath));
repo.upsertUser(username, await bcrypt.hash(password, 12));
repo.resetLoginFailures(username);
repo.addEvent({ category: 'SECURITY', event: 'USER_UPSERT', severity: 'WARNING', message: `Usuário "${username}" criado/atualizado via CLI${password.length < 12 ? ' (SENHA FRACA — trocar)' : ''}` });
console.log(`Usuário "${username}" salvo.`);
