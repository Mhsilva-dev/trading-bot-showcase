// Logs estruturados: saem no stdout (capturado pelo PM2) e vão para a
// tabela bot_events, que alimenta a tela de Logs e os Alertas do painel.
//
// Categorias: SYSTEM, BROKER, MARKET, STRATEGY, RISK, TRADE, ERROR, SECURITY
// Níveis:     INFO, WARNING, ERROR, TRADE, CRITICAL

const SECRET_KEYS = /(secret|password|passwd|token|authorization|api[_-]?key|client_id|client_secret|cookie)/i;

let registeredSecrets = [];

// Valores que nunca podem aparecer em log (ex.: API_SECRET carregada do .env).
export function registerSecrets(values) {
  registeredSecrets = values.filter((v) => typeof v === 'string' && v.length >= 6);
}

export function redact(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') {
    let s = value;
    for (const sec of registeredSecrets) s = s.split(sec).join('***');
    return s.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***');
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: redact(value.message), kind: value.kind, status: value.status };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '***' : redact(v, depth + 1);
    return out;
  }
  return value;
}

const ALERT_EVENTS = new Set([
  'ORDER_FILLED', 'STOP_LOSS', 'TAKE_PROFIT', 'BROKER_OFFLINE', 'RECONCILE_MISMATCH',
  'DAILY_LOSS_HALT', 'BOT_STOPPED', 'EMERGENCY_STOP', 'FAIL_SAFE', 'ORDER_UNKNOWN',
]);

export class Logger {
  constructor({ repo = null, accountId = null, quiet = false } = {}) {
    this.repo = repo;
    this.accountId = accountId;
    this.quiet = quiet;
    // Ganchos para integrações futuras (Telegram, e-mail, push...).
    this.notifiers = [];
  }

  child(accountId) {
    const l = new Logger({ repo: this.repo, accountId, quiet: this.quiet });
    l.notifiers = this.notifiers;
    return l;
  }

  log(severity, category, event, message, metadata) {
    const meta = metadata === undefined ? undefined : redact(metadata);
    const msg = redact(String(message));
    const alert = ALERT_EVENTS.has(event) || severity === 'CRITICAL';
    const line = {
      ts: new Date().toISOString(), level: severity, category, event, account: this.accountId, message: msg,
      ...(meta ? { metadata: meta } : {}),
    };
    if (!this.quiet) {
      const out = severity === 'ERROR' || severity === 'CRITICAL' ? process.stderr : process.stdout;
      out.write(`${JSON.stringify(line)}\n`);
    }
    if (this.repo) {
      try {
        this.repo.addEvent({ accountId: this.accountId, category, event, severity, message: msg, metadata: meta, alert });
      } catch (err) {
        // Banco indisponível: o log continua no stdout. Quem opera precisa
        // checar dbHealthy() — aqui não dá para fazer mais nada com segurança.
        process.stderr.write(`${JSON.stringify({ level: 'CRITICAL', category: 'SYSTEM', message: `falha ao gravar log no banco: ${err.message}` })}\n`);
      }
    }
    if (alert) for (const n of this.notifiers) Promise.resolve().then(() => n(line)).catch(() => {});
  }

  info(category, event, message, metadata) { this.log('INFO', category, event, message, metadata); }
  warn(category, event, message, metadata) { this.log('WARNING', category, event, message, metadata); }
  error(category, event, message, metadata) { this.log('ERROR', category, event, message, metadata); }
  trade(event, message, metadata) { this.log('TRADE', 'TRADE', event, message, metadata); }
  critical(category, event, message, metadata) { this.log('CRITICAL', category, event, message, metadata); }
}
