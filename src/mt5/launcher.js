// Processo PM2 "trading-mt5": liga/desliga o MetaTrader 5 (Wine, sem tela)
// no horário do pregão, faz login com a conta XP cadastrada no painel e
// monitora a ponte. NÃO envia ordens — isso é do bot, via TradingBridge.
//
// Segurança:
//  - o MT5 roda como o usuário "mt5" (sem privilégios), isolado do resto;
//  - a senha é decifrada só na hora de iniciar, gravada num .ini 0600 do
//    usuário mt5 e APAGADA assim que o terminal carrega;
//  - se a conta conectada não bater com o cadastro (login ou DEMO/REAL),
//    o status vira ERROR e o bot bloqueia a conta.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { config } from '../config/index.js';
import { openDatabase } from '../database/db.js';
import { Repo } from '../database/repo.js';
import { Logger, registerSecrets } from '../monitoring/logger.js';
import { getBrokerCredential } from '../security/credentials.js';
import { mt5ShouldRun } from './schedule.js';
import { effectiveSettings } from '../bot/settings.js';
import { registerAccounts, mt5BridgeDir, B3_WATCHLIST } from '../bot/accounts.js';
import { nowIso, sleep } from '../lib/util.js';

registerSecrets([config.credentialsKey, config.dashboard.sessionSecret, config.broker.apiSecret]);

const MT5 = config.mt5;
const MT_DIR = path.join(MT5.home, '.wine/drive_c/Program Files/MetaTrader 5');
const BRIDGE = mt5BridgeDir(config);
const INI = path.join(MT_DIR, 'Config', 'tb-start.ini');
const LOOP_MS = 20_000;
const CONNECT_GRACE_MS = 180_000;

const db = openDatabase(config.databasePath);
const repo = new Repo(db);
registerAccounts(repo);
const log = new Logger({ repo }).child('xp');

function mt5User() {
  const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith('mt5:'));
  if (!line) throw new Error('Usuário "mt5" não existe (veja README: instalação do MT5)');
  const [, , uid, gid] = line.split(':');
  return { uid: Number(uid), gid: Number(gid) };
}

const { uid, gid } = mt5User();
const wineEnv = { HOME: MT5.home, WINEPREFIX: path.join(MT5.home, '.wine'), WINEDEBUG: '-all', DISPLAY: MT5.display, PATH: '/usr/bin:/bin' };

let xvfb = null;
let terminal = null;
let startedAt = 0;
let startedFor = null; // updated_at da credencial usada
let lastStatus = null;

function setBridge(status, message) {
  db.prepare('UPDATE broker_credentials SET bridge_status = ?, bridge_message = ?, bridge_seen_at = ? WHERE provider = ?')
    .run(status, message, nowIso(), 'xp_mt5');
  const key = `${status}|${message}`;
  if (key !== lastStatus) {
    lastStatus = key;
    const sev = status === 'ERROR' ? 'error' : 'info';
    log[sev]('BROKER', `MT5_${status}`, `MT5: ${message}`);
  }
}

function chown(p) { fs.chownSync(p, uid, gid); }

// Aviso para o bot: STARTING = aguarde (não conte como erro); RUNNING; STOPPED.
function setPhase(status) {
  try {
    const f = path.join(BRIDGE, 'launcher.json');
    fs.writeFileSync(`${f}.tmp`, JSON.stringify({ status, ts: Date.now() }));
    fs.renameSync(`${f}.tmp`, f);
  } catch { /* pasta ainda não existe */ }
}

function prepareDirs() {
  for (const d of [BRIDGE, path.join(BRIDGE, 'in'), path.join(BRIDGE, 'out')]) {
    fs.mkdirSync(d, { recursive: true });
    chown(d);
    fs.chmodSync(d, 0o775);
  }
}

function writeWatchlist() {
  const s = effectiveSettings(repo, { ...config.defaults, symbol: 'PETR4F' }, 'xp');
  const list = [...new Set([s.symbol, ...B3_WATCHLIST])];
  const f = path.join(BRIDGE, 'symbols.txt');
  const tmp = `${f}.launcher.tmp`;
  fs.writeFileSync(tmp, `${list.join('\n')}\n`, { mode: 0o664 });
  chown(tmp);
  fs.renameSync(tmp, f);
  return list;
}

function writeIni(cred, chartSymbol) {
  const lines = [
    '[Common]',
    `Login=${cred.login}`,
    `Password=${cred.password}`,
    `Server=${cred.server}`,
    'KeepPrivate=1',
    'NewsEnable=0',
    '[Experts]',
    'AllowLiveTrading=1',
    'AllowDllImport=0',
    'Enabled=1',
    'Account=0',
    'Profile=0',
    '[StartUp]',
    'Expert=TradingBridge',
    `Symbol=${chartSymbol}`,
    'Period=M15',
  ];
  // O MT5 grava os próprios .ini em UTF-16LE; usamos o mesmo formato.
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf16le')]);
  fs.writeFileSync(INI, buf, { mode: 0o600 });
  chown(INI);
}

function removeIni() {
  try { fs.rmSync(INI, { force: true }); } catch { /* já removido */ }
}

function startTerminal(cred, row) {
  prepareDirs();
  // Estado do terminal anterior não vale para este: evita "conectado" falso.
  fs.rmSync(path.join(BRIDGE, 'state.json'), { force: true });
  const watch = writeWatchlist();
  // Gráfico que hospeda o EA: ativo do mercado padrão, sempre com histórico.
  writeIni(cred, process.env.MT5_CHART_SYMBOL || 'PETR4');
  xvfb = spawn('Xvfb', [MT5.display, '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], { uid, gid, env: wineEnv, stdio: 'ignore' });
  xvfb.on('exit', () => { xvfb = null; });
  terminal = spawn('/usr/lib/wine/wine64', ['terminal64.exe', '/portable', '/config:Config\\tb-start.ini'], { cwd: MT_DIR, uid, gid, env: wineEnv, stdio: 'ignore' });
  terminal.on('exit', (code) => {
    terminal = null;
    log.warn('BROKER', 'MT5_EXITED', `Terminal MT5 encerrou (código ${code})`);
  });
  startedAt = Date.now();
  startedFor = row.updated_at;
  setPhase('STARTING');
  // Remove a senha do disco assim que o terminal teve tempo de ler o .ini.
  setTimeout(removeIni, 60_000).unref();
  log.info('SYSTEM', 'MT5_STARTED', `MetaTrader 5 iniciado (${cred.environment.toUpperCase()}, servidor ${cred.server})`);
  setBridge('WAITING', 'Iniciando MetaTrader 5 e conectando à XP…');
}

async function stopTerminal(reason) {
  if (!terminal && !xvfb) return;
  log.info('SYSTEM', 'MT5_STOPPING', `Desligando MetaTrader 5: ${reason}`);
  try {
    execFileSync('/usr/lib/wine/wineserver64', ['-k'], { uid, gid, env: wineEnv, timeout: 20_000 });
  } catch { /* segue para o kill */ }
  for (let i = 0; i < 20 && terminal; i++) await sleep(500);
  terminal?.kill('SIGKILL');
  xvfb?.kill('SIGTERM');
  terminal = null;
  xvfb = null;
  removeIni();
  setPhase('STOPPED');
}

function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(BRIDGE, 'state.json'), 'utf8')); } catch { return null; }
}

function checkHealth(cred) {
  const s = readState();
  const age = s ? Date.now() / 1000 - Number(s.ts) : Infinity;
  const booting = Date.now() - startedAt < CONNECT_GRACE_MS;
  const fromThisRun = s && Number(s.ts) * 1000 >= startedAt - 2000;
  if (!s || s.stopped || age > 15 || !fromThisRun) {
    return booting ? setBridge('WAITING', 'Aguardando o EA TradingBridge publicar estado…')
      : setBridge('ERROR', 'EA TradingBridge não está publicando estado (verifique login/servidor)');
  }
  if (!s.connected) {
    return booting ? setBridge('WAITING', 'Conectando ao servidor da XP…')
      : setBridge('ERROR', `Sem conexão com o servidor "${cred.server}" — confira servidor, login e senha`);
  }
  if (String(s.account?.login) !== String(cred.login)) {
    return setBridge('ERROR', `MT5 conectado na conta ${s.account?.login}, diferente da cadastrada`);
  }
  const real = Number(s.account?.trade_mode) === 2;
  if (cred.environment === 'demo' && real) return setBridge('ERROR', 'Conta conectada é REAL, mas o cadastro é DEMO — bloqueado');
  if (!s.terminal_trade_allowed || !s.ea_trade_allowed) return setBridge('ERROR', 'Negociação algorítmica desabilitada no terminal');
  setPhase('RUNNING');
  const tipo = real ? 'REAL' : Number(s.account?.trade_mode) === 0 ? 'DEMO' : 'CONTEST';
  return setBridge('CONNECTED', `${s.account.company || 'XP'} · conta ${tipo} · saldo ${s.account.currency} ${Number(s.account.balance).toFixed(2)}`);
}

let running = true;
async function loop() {
  log.info('SYSTEM', 'MT5_LAUNCHER', `Launcher MT5 ativo (janela ${MT5.alwaysOn ? '24h' : `${MT5.startTime}–${MT5.stopTime} dias úteis`})`);
  while (running) {
    try {
      const row = repo.getCredential('xp_mt5');
      if (!row) {
        await stopTerminal('conta XP removida do painel');
      } else {
        let cred = null;
        try {
          cred = getBrokerCredential(repo, config.credentialsKey, 'xp_mt5');
        } catch (e) {
          setBridge('ERROR', `Não foi possível decifrar a credencial: ${e.message}`);
        }
        const should = cred && mt5ShouldRun(MT5);
        if (cred && startedFor && startedFor !== row.updated_at && terminal) await stopTerminal('credencial atualizada no painel');
        if (should && !terminal) startTerminal(cred, row);
        else if (!should && terminal) await stopTerminal('fora do horário do pregão');
        if (terminal && cred) checkHealth(cred);
        else if (cred && !should) setBridge('OFF_HOURS', `Fora do horário (liga às ${MT5.startTime} em dias úteis)`);
        if (terminal) writeWatchlist();
      }
    } catch (e) {
      log.error('ERROR', 'MT5_LAUNCHER_ERROR', `Launcher MT5: ${e.message}`);
    }
    await sleep(LOOP_MS);
  }
}

async function shutdown(sig) {
  running = false;
  await stopTerminal(`launcher encerrando (${sig})`);
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

loop();
