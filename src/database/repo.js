import { nowIso } from '../lib/util.js';

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (v) => {
  if (v === null || v === undefined) return null;
  try { return JSON.parse(v); } catch { return null; }
};

const ACTIVE_ORDER_STATUSES = ['PENDING_SUBMIT', 'OPEN', 'PARTIAL', 'UNKNOWN'];

// Acesso ao banco agrupado por entidade. Todos os métodos são síncronos
// (better-sqlite3), o que torna as transações simples e atômicas.
export class Repo {
  constructor(db) {
    this.db = db;
  }

  tx(fn) {
    return this.db.transaction(fn)();
  }

  // ---------------- contas / controle / estado ----------------
  ensureAccount({ id, name, broker, mode }) {
    this.db.prepare(`INSERT INTO accounts (id, name, broker, mode) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, broker=excluded.broker, mode=excluded.mode`)
      .run(id, name, broker, mode);
    this.db.prepare(`INSERT OR IGNORE INTO bot_control (account_id, desired, emergency, updated_at)
      VALUES (?, 'STOPPED', 0, ?)`).run(id, nowIso());
  }

  listAccounts() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY mode, id').all();
  }

  getAccount(id) {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  }

  getControl(accountId) {
    const r = this.db.prepare('SELECT * FROM bot_control WHERE account_id = ?').get(accountId);
    return r ? { ...r, emergency: !!r.emergency } : { desired: 'STOPPED', emergency: false };
  }

  setControl(accountId, patch, by = 'system') {
    const cur = this.getControl(accountId);
    const desired = patch.desired ?? cur.desired;
    const emergency = patch.emergency ?? cur.emergency;
    this.db.prepare(`INSERT INTO bot_control (account_id, desired, emergency, updated_at, updated_by)
      VALUES (@a, @d, @e, @t, @b)
      ON CONFLICT(account_id) DO UPDATE SET desired=@d, emergency=@e, updated_at=@t, updated_by=@b`)
      .run({ a: accountId, d: desired, e: emergency ? 1 : 0, t: nowIso(), b: by });
    return this.getControl(accountId);
  }

  saveState(accountId, state) {
    const t = nowIso();
    this.db.prepare(`INSERT INTO bot_state (account_id, status, reason, risk_status, risk_reason, broker_status,
        last_analysis_at, next_check_at, last_signal, last_price, heartbeat_at, data, updated_at)
      VALUES (@account_id, @status, @reason, @risk_status, @risk_reason, @broker_status,
        @last_analysis_at, @next_check_at, @last_signal, @last_price, @heartbeat_at, @data, @updated_at)
      ON CONFLICT(account_id) DO UPDATE SET status=@status, reason=@reason, risk_status=@risk_status,
        risk_reason=@risk_reason, broker_status=@broker_status, last_analysis_at=@last_analysis_at,
        next_check_at=@next_check_at, last_signal=@last_signal, last_price=@last_price,
        heartbeat_at=@heartbeat_at, data=@data, updated_at=@updated_at`)
      .run({
        account_id: accountId,
        status: state.status,
        reason: state.reason ?? null,
        risk_status: state.riskStatus ?? null,
        risk_reason: state.riskReason ?? null,
        broker_status: state.brokerStatus ?? null,
        last_analysis_at: state.lastAnalysisAt ?? null,
        next_check_at: state.nextCheckAt ?? null,
        last_signal: state.lastSignal ?? null,
        last_price: state.lastPrice ?? null,
        heartbeat_at: t,
        data: json(state.data),
        updated_at: t,
      });
  }

  getState(accountId) {
    const r = this.db.prepare('SELECT * FROM bot_state WHERE account_id = ?').get(accountId);
    return r ? { ...r, data: parse(r.data) } : null;
  }

  // ---------------- settings ----------------
  getSettings(accountId) {
    const rows = this.db.prepare('SELECT key, value FROM settings WHERE account_id = ?').all(accountId);
    return Object.fromEntries(rows.map((r) => [r.key, parse(r.value)]));
  }

  setSettings(accountId, values) {
    const st = this.db.prepare(`INSERT INTO settings (account_id, key, value, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(account_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
    this.tx(() => {
      for (const [k, v] of Object.entries(values)) st.run(accountId, k, JSON.stringify(v), nowIso());
    });
  }

  // ---------------- eventos / logs ----------------
  addEvent({ accountId = null, category, event, severity = 'INFO', message, metadata, alert = false }) {
    const info = this.db.prepare(`INSERT INTO bot_events (account_id, category, event, severity, message, metadata, alert)
      VALUES (?,?,?,?,?,?,?)`).run(accountId, category, event, severity, message, json(metadata), alert ? 1 : 0);
    return info.lastInsertRowid;
  }

  listEvents({ accountId, severity, category, afterId, limit = 100, offset = 0, alertsOnly = false } = {}) {
    const where = [];
    const p = {};
    if (accountId) { where.push('(account_id = @a OR account_id IS NULL)'); p.a = accountId; }
    if (severity) {
      const list = [].concat(severity);
      where.push(`severity IN (${list.map((_, i) => `@s${i}`).join(',')})`);
      list.forEach((s, i) => { p[`s${i}`] = s; });
    }
    if (category) { where.push('category = @c'); p.c = category; }
    if (afterId) { where.push('id > @after'); p.after = afterId; }
    if (alertsOnly) where.push('alert = 1');
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM bot_events ${w} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
      .all({ ...p, limit, offset });
    const total = this.db.prepare(`SELECT COUNT(*) n FROM bot_events ${w}`).get(p).n;
    return { rows: rows.map((r) => ({ ...r, metadata: parse(r.metadata) })), total };
  }

  lastEventId() {
    return this.db.prepare('SELECT COALESCE(MAX(id),0) id FROM bot_events').get().id;
  }

  markAlertsRead(accountId) {
    this.db.prepare('UPDATE bot_events SET alert_read = 1 WHERE alert = 1 AND (account_id = ? OR account_id IS NULL)').run(accountId);
  }

  unreadAlerts(accountId) {
    return this.db.prepare(`SELECT COUNT(*) n FROM bot_events WHERE alert = 1 AND alert_read = 0
      AND (account_id = ? OR account_id IS NULL)`).get(accountId).n;
  }

  // ---------------- comandos (painel -> bot) ----------------
  addCommand(accountId, command, payload, by) {
    return this.db.prepare('INSERT INTO commands (account_id, command, payload, created_by) VALUES (?,?,?,?)')
      .run(accountId, command, json(payload), by).lastInsertRowid;
  }

  pendingCommands() {
    return this.db.prepare("SELECT * FROM commands WHERE status = 'PENDING' ORDER BY id").all()
      .map((c) => ({ ...c, payload: parse(c.payload) }));
  }

  finishCommand(id, ok, result) {
    this.db.prepare('UPDATE commands SET status = ?, result = ?, processed_at = ? WHERE id = ?')
      .run(ok ? 'DONE' : 'FAILED', json(result), nowIso(), id);
  }

  getCommand(id) {
    const c = this.db.prepare('SELECT * FROM commands WHERE id = ?').get(id);
    return c ? { ...c, payload: parse(c.payload), result: parse(c.result) } : null;
  }

  // ---------------- ordens ----------------
  insertOrderIntent(o) {
    const t = nowIso();
    const info = this.db.prepare(`INSERT INTO orders (account_id, client_order_id, symbol, side, type, quantity, cost,
        price, status, purpose, trade_id, created_at, updated_at)
      VALUES (@account_id, @client_order_id, @symbol, @side, @type, @quantity, @cost, @price, 'PENDING_SUBMIT',
        @purpose, @trade_id, @t, @t)`)
      .run({ quantity: null, cost: null, price: null, trade_id: null, ...o, t });
    return this.getOrder(info.lastInsertRowid);
  }

  updateOrder(id, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return this.getOrder(id);
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE orders SET ${sets}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...patch, updated_at: nowIso(), id });
    return this.getOrder(id);
  }

  getOrder(id) {
    return this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  }

  activeOrders(accountId) {
    return this.db.prepare(`SELECT * FROM orders WHERE account_id = ? AND status IN (${ACTIVE_ORDER_STATUSES.map(() => '?').join(',')}) ORDER BY id`)
      .all(accountId, ...ACTIVE_ORDER_STATUSES);
  }

  listOrders({ accountId, symbol, side, status, from, to, limit = 50, offset = 0 }) {
    const where = ['account_id = @a'];
    const p = { a: accountId };
    if (symbol) { where.push('symbol = @symbol'); p.symbol = symbol; }
    if (side) { where.push('side = @side'); p.side = side; }
    if (status) { where.push('status = @status'); p.status = status; }
    if (from) { where.push('created_at >= @from'); p.from = from; }
    if (to) { where.push('created_at <= @to'); p.to = to; }
    const w = `WHERE ${where.join(' AND ')}`;
    return {
      rows: this.db.prepare(`SELECT * FROM orders ${w} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all({ ...p, limit, offset }),
      total: this.db.prepare(`SELECT COUNT(*) n FROM orders ${w}`).get(p).n,
    };
  }

  // Execuções: ordens com algo executado, com o resultado do trade nas vendas.
  listExecutions({ accountId, symbol, side, result, from, to, limit = 50, offset = 0 }) {
    const where = ["o.account_id = @a", "o.filled_quantity > 0"];
    const p = { a: accountId };
    if (symbol) { where.push('o.symbol = @symbol'); p.symbol = symbol; }
    if (side) { where.push('o.side = @side'); p.side = side; }
    if (result === 'WIN') where.push("o.side = 'SELL' AND t.profit_loss > 0");
    if (result === 'LOSS') where.push("o.side = 'SELL' AND t.profit_loss <= 0");
    if (from) { where.push('o.updated_at >= @from'); p.from = from; }
    if (to) { where.push('o.updated_at <= @to'); p.to = to; }
    const w = `WHERE ${where.join(' AND ')}`;
    const base = `FROM orders o LEFT JOIN trades t ON t.id = o.trade_id ${w}`;
    return {
      rows: this.db.prepare(`SELECT o.id, o.updated_at AS date, o.symbol, o.side, o.avg_fill_price AS price,
          o.filled_quantity AS quantity, o.fees, o.status, o.purpose, t.strategy,
          CASE WHEN o.side = 'SELL' THEN t.profit_loss END AS result
        ${base} ORDER BY o.id DESC LIMIT @limit OFFSET @offset`).all({ ...p, limit, offset }),
      total: this.db.prepare(`SELECT COUNT(*) n ${base}`).get(p).n,
    };
  }

  // ---------------- trades ----------------
  openTrade(t) {
    const info = this.db.prepare(`INSERT INTO trades (account_id, symbol, side, entry_price, quantity, entry_cost, fees,
        status, strategy, entry_order_id, opened_at)
      VALUES (@account_id, @symbol, 'BUY', @entry_price, @quantity, @entry_cost, @fees, 'OPEN', @strategy, @entry_order_id, @opened_at)`)
      .run({ opened_at: nowIso(), ...t });
    return this.getTrade(info.lastInsertRowid);
  }

  closeTrade(id, { exit_price, fees, profit_loss, exit_reason, exit_order_id }) {
    this.db.prepare(`UPDATE trades SET exit_price = ?, fees = ?, profit_loss = ?, exit_reason = ?, exit_order_id = ?,
      status = 'CLOSED', closed_at = ? WHERE id = ?`)
      .run(exit_price, fees, profit_loss, exit_reason, exit_order_id, nowIso(), id);
    return this.getTrade(id);
  }

  updateTrade(id, patch) {
    const sets = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE trades SET ${sets} WHERE id = @id`).run({ ...patch, id });
    return this.getTrade(id);
  }

  getTrade(id) {
    return this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
  }

  openTradeFor(accountId, symbol) {
    return this.db.prepare("SELECT * FROM trades WHERE account_id = ? AND symbol = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1")
      .get(accountId, symbol);
  }

  listTrades({ accountId, symbol, result, from, to, limit = 50, offset = 0 }) {
    const where = ['account_id = @a'];
    const p = { a: accountId };
    if (symbol) { where.push('symbol = @symbol'); p.symbol = symbol; }
    if (result === 'WIN') where.push("status = 'CLOSED' AND profit_loss > 0");
    if (result === 'LOSS') where.push("status = 'CLOSED' AND profit_loss <= 0");
    if (from) { where.push('opened_at >= @from'); p.from = from; }
    if (to) { where.push('opened_at <= @to'); p.to = to; }
    const w = `WHERE ${where.join(' AND ')}`;
    return {
      rows: this.db.prepare(`SELECT * FROM trades ${w} ORDER BY id DESC LIMIT @limit OFFSET @offset`).all({ ...p, limit, offset }),
      total: this.db.prepare(`SELECT COUNT(*) n FROM trades ${w}`).get(p).n,
    };
  }

  closedTradesSince(accountId, iso) {
    return this.db.prepare("SELECT * FROM trades WHERE account_id = ? AND status = 'CLOSED' AND closed_at >= ?").all(accountId, iso);
  }

  entriesSince(accountId, iso) {
    return this.db.prepare(`SELECT COUNT(*) n FROM orders WHERE account_id = ? AND purpose = 'ENTRY'
      AND status NOT IN ('REJECTED','CANCELED') AND created_at >= ?`).get(accountId, iso).n;
  }

  tradeStats(accountId) {
    return this.db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed,
        SUM(CASE WHEN status='CLOSED' AND profit_loss > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN status='CLOSED' AND profit_loss <= 0 THEN 1 ELSE 0 END) AS losses,
        COALESCE(SUM(CASE WHEN status='CLOSED' THEN profit_loss END), 0) AS realized,
        COALESCE(SUM(fees), 0) AS fees,
        MAX(CASE WHEN status='CLOSED' THEN profit_loss END) AS best,
        MIN(CASE WHEN status='CLOSED' THEN profit_loss END) AS worst
      FROM trades WHERE account_id = ?`).get(accountId);
  }

  // ---------------- posições ----------------
  openPosition(accountId, symbol) {
    return this.db.prepare("SELECT * FROM positions WHERE account_id = ? AND symbol = ? AND status = 'OPEN'").get(accountId, symbol);
  }

  anyOpenPosition(accountId) {
    return this.db.prepare("SELECT * FROM positions WHERE account_id = ? AND status = 'OPEN'").all(accountId);
  }

  createPosition(p) {
    const t = nowIso();
    const info = this.db.prepare(`INSERT INTO positions (account_id, symbol, quantity, average_price, current_price,
        stop_price, take_profit_price, trade_id, status, opened_at, updated_at)
      VALUES (@account_id, @symbol, @quantity, @average_price, @average_price, @stop_price, @take_profit_price, @trade_id, 'OPEN', @t, @t)`)
      .run({ ...p, t });
    return this.db.prepare('SELECT * FROM positions WHERE id = ?').get(info.lastInsertRowid);
  }

  updatePosition(id, patch) {
    const keys = Object.keys(patch);
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE positions SET ${sets}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...patch, updated_at: nowIso(), id });
  }

  listPositions(accountId, includeClosed = false) {
    return this.db.prepare(`SELECT * FROM positions WHERE account_id = ? ${includeClosed ? '' : "AND status = 'OPEN'"} ORDER BY id DESC LIMIT 100`)
      .all(accountId);
  }

  // ---------------- sinais ----------------
  addSignal(s) {
    return this.db.prepare(`INSERT INTO strategy_signals (account_id, symbol, signal, price, reason, confidence, indicators, candle_time)
      VALUES (@account_id, @symbol, @signal, @price, @reason, @confidence, @indicators, @candle_time)`)
      .run({ ...s, indicators: json(s.indicators), candle_time: s.candle_time ?? null }).lastInsertRowid;
  }

  listSignals(accountId, { limit = 50, signal } = {}) {
    const rows = signal
      ? this.db.prepare('SELECT * FROM strategy_signals WHERE account_id = ? AND signal = ? ORDER BY id DESC LIMIT ?').all(accountId, signal, limit)
      : this.db.prepare('SELECT * FROM strategy_signals WHERE account_id = ? ORDER BY id DESC LIMIT ?').all(accountId, limit);
    return rows.map((r) => ({ ...r, indicators: parse(r.indicators) }));
  }

  // ---------------- patrimônio / métricas ----------------
  addEquitySnapshot(accountId, { balance, equity, positionValue }) {
    this.db.prepare('INSERT INTO equity_snapshots (account_id, ts, balance, equity, position_value) VALUES (?,?,?,?,?)')
      .run(accountId, nowIso(), balance, equity, positionValue);
  }

  lastEquitySnapshot(accountId) {
    return this.db.prepare('SELECT * FROM equity_snapshots WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(accountId);
  }

  equitySeries(accountId, fromIso, toIso) {
    return this.db.prepare(`SELECT ts, balance, equity FROM equity_snapshots WHERE account_id = ?
      AND ts >= ? AND ts <= ? ORDER BY ts`).all(accountId, fromIso || '0000', toIso || '9999');
  }

  getDaily(accountId, date) {
    return this.db.prepare('SELECT * FROM daily_metrics WHERE account_id = ? AND date = ?').get(accountId, date);
  }

  upsertDaily(accountId, date, m) {
    this.db.prepare(`INSERT INTO daily_metrics (account_id, date, starting_balance, ending_balance, peak_balance,
        profit_loss, fees, trades, wins, losses, drawdown)
      VALUES (@a, @date, @starting_balance, @ending_balance, @peak_balance, @profit_loss, @fees, @trades, @wins, @losses, @drawdown)
      ON CONFLICT(account_id, date) DO UPDATE SET ending_balance=@ending_balance, peak_balance=@peak_balance,
        profit_loss=@profit_loss, fees=@fees, trades=@trades, wins=@wins, losses=@losses, drawdown=@drawdown`)
      .run({ a: accountId, date, ...m });
  }

  listDaily(accountId, from, to) {
    return this.db.prepare('SELECT * FROM daily_metrics WHERE account_id = ? AND date >= ? AND date <= ? ORDER BY date')
      .all(accountId, from || '0000', to || '9999');
  }

  // ---------------- candles ----------------
  saveCandles(symbol, timeframe, candles) {
    const st = this.db.prepare(`INSERT INTO market_candles (symbol, timeframe, t, o, h, l, c, v) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(symbol, timeframe, t) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v`);
    this.tx(() => { for (const k of candles) st.run(symbol, timeframe, k.t, k.o, k.h, k.l, k.c, k.v); });
  }

  getCandles(symbol, timeframe, limit = 300) {
    return this.db.prepare('SELECT t, o, h, l, c, v FROM market_candles WHERE symbol = ? AND timeframe = ? ORDER BY t DESC LIMIT ?')
      .all(symbol, timeframe, limit).reverse();
  }

  // ---------------- credenciais de corretora ----------------
  getCredential(provider) {
    return this.db.prepare('SELECT * FROM broker_credentials WHERE provider = ?').get(provider);
  }

  saveCredential({ provider, environment, server, login, secret_enc, updated_by }) {
    this.db.prepare(`INSERT INTO broker_credentials (provider, environment, server, login, secret_enc, updated_at, updated_by)
      VALUES (@provider, @environment, @server, @login, @secret_enc, @t, @updated_by)
      ON CONFLICT(provider) DO UPDATE SET environment=@environment, server=@server, login=@login, secret_enc=@secret_enc,
        updated_at=@t, updated_by=@updated_by, bridge_status=NULL, bridge_message=NULL, bridge_seen_at=NULL`)
      .run({ provider, environment, server, login, secret_enc, updated_by, t: nowIso() });
  }

  deleteCredential(provider) {
    return this.db.prepare('DELETE FROM broker_credentials WHERE provider = ?').run(provider).changes;
  }

  // ---------------- usuários ----------------
  getUser(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  }

  upsertUser(username, hash) {
    this.db.prepare(`INSERT INTO users (username, password_hash) VALUES (?, ?)
      ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`).run(username, hash);
  }

  // Registra uma falha de login; após `max` falhas seguidas, trava por `lockMs`.
  registerLoginFailure(username, { max = 5, lockMs = 3_600_000, now = Date.now() } = {}) {
    const u = this.getUser(username);
    if (!u) return null;
    const attempts = u.failed_attempts + 1;
    const locked = attempts >= max ? now + lockMs : u.locked_until;
    this.db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts >= max ? 0 : attempts, locked, u.id);
    return { attempts, lockedUntil: locked };
  }

  resetLoginFailures(username) {
    this.db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE username = ?').run(username);
  }

  deleteUser(username) {
    return this.db.prepare('DELETE FROM users WHERE username = ?').run(username).changes;
  }

  listUsers() {
    return this.db.prepare('SELECT id, username, created_at, locked_until FROM users ORDER BY id').all();
  }

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) n FROM users').get().n;
  }
}
