// Esquema do banco. Migrações são idempotentes (CREATE IF NOT EXISTS) e
// versionadas via PRAGMA user_version.
const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    broker TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('paper','live')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (account_id, key)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    symbol TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'BUY',
    entry_price REAL NOT NULL,
    exit_price REAL,
    quantity REAL NOT NULL,
    entry_cost REAL NOT NULL DEFAULT 0,
    exit_qty REAL NOT NULL DEFAULT 0,
    exit_proceeds REAL NOT NULL DEFAULT 0,
    fees REAL NOT NULL DEFAULT 0,
    profit_loss REAL,
    status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
    strategy TEXT NOT NULL,
    exit_reason TEXT,
    entry_order_id INTEGER,
    exit_order_id INTEGER,
    opened_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_trades_acc ON trades(account_id, opened_at);

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    client_order_id TEXT NOT NULL UNIQUE,
    broker_order_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
    type TEXT NOT NULL,
    quantity REAL,
    cost REAL,
    price REAL,
    filled_quantity REAL NOT NULL DEFAULT 0,
    avg_fill_price REAL,
    fees REAL NOT NULL DEFAULT 0,
    fee_base REAL NOT NULL DEFAULT 0,
    fee_quote REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('PENDING_SUBMIT','OPEN','PARTIAL','FILLED','CANCELED','REJECTED','UNKNOWN')),
    purpose TEXT NOT NULL,
    trade_id INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_acc ON orders(account_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(account_id, status);

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    symbol TEXT NOT NULL,
    quantity REAL NOT NULL,
    average_price REAL NOT NULL,
    current_price REAL,
    unrealized_profit REAL NOT NULL DEFAULT 0,
    stop_price REAL,
    take_profit_price REAL,
    trade_id INTEGER,
    status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
    opened_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_open ON positions(account_id, symbol) WHERE status = 'OPEN';

  CREATE TABLE IF NOT EXISTS bot_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT,
    category TEXT NOT NULL,
    event TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','ERROR','TRADE','CRITICAL')),
    message TEXT NOT NULL,
    metadata TEXT,
    alert INTEGER NOT NULL DEFAULT 0,
    alert_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_acc ON bot_events(account_id, id);

  CREATE TABLE IF NOT EXISTS daily_metrics (
    account_id TEXT NOT NULL REFERENCES accounts(id),
    date TEXT NOT NULL,
    starting_balance REAL NOT NULL,
    ending_balance REAL NOT NULL,
    peak_balance REAL NOT NULL,
    profit_loss REAL NOT NULL DEFAULT 0,
    fees REAL NOT NULL DEFAULT 0,
    trades INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    drawdown REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, date)
  );

  CREATE TABLE IF NOT EXISTS strategy_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    symbol TEXT NOT NULL,
    signal TEXT NOT NULL CHECK (signal IN ('BUY','SELL','HOLD')),
    price REAL,
    reason TEXT NOT NULL,
    confidence REAL,
    indicators TEXT,
    candle_time INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_signals_acc ON strategy_signals(account_id, id);

  CREATE TABLE IF NOT EXISTS equity_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    ts TEXT NOT NULL,
    balance REAL NOT NULL,
    equity REAL NOT NULL,
    position_value REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_equity_acc ON equity_snapshots(account_id, ts);

  CREATE TABLE IF NOT EXISTS market_candles (
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    t INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL,
    PRIMARY KEY (symbol, timeframe, t)
  );

  -- Estado corrente de cada conta, escrito pelo bot e lido pelo painel.
  CREATE TABLE IF NOT EXISTS bot_state (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    status TEXT NOT NULL,
    reason TEXT,
    risk_status TEXT,
    risk_reason TEXT,
    broker_status TEXT,
    last_analysis_at TEXT,
    next_check_at TEXT,
    last_signal TEXT,
    last_price REAL,
    heartbeat_at TEXT,
    data TEXT,
    updated_at TEXT NOT NULL
  );

  -- Estado DESEJADO pelo operador. Persistente: sobrevive a reinícios.
  CREATE TABLE IF NOT EXISTS bot_control (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    desired TEXT NOT NULL DEFAULT 'STOPPED' CHECK (desired IN ('RUNNING','PAUSED','STOPPED')),
    emergency INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS commands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    command TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DONE','FAILED')),
    result TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    processed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS paper_balances (
    account_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    available REAL NOT NULL DEFAULT 0,
    on_hold REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, asset)
  );

  CREATE TABLE IF NOT EXISTS paper_orders (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    external_id TEXT,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    type TEXT NOT NULL,
    qty REAL,
    cost REAL,
    filled_qty REAL NOT NULL DEFAULT 0,
    avg_price REAL,
    fee REAL NOT NULL DEFAULT 0,
    fee_asset TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_ext ON paper_orders(account_id, external_id);

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backtests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    params TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,
  // v2: credenciais de corretora cadastradas pelo painel (senha cifrada).
  `
  CREATE TABLE IF NOT EXISTS broker_credentials (
    provider TEXT PRIMARY KEY,
    environment TEXT NOT NULL CHECK (environment IN ('demo','real')),
    server TEXT NOT NULL,
    login TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    bridge_status TEXT,
    bridge_message TEXT,
    bridge_seen_at TEXT
  );
  `,
  // v3: contas do tipo 'demo' (corretora real com dinheiro fictício, ex.: XP MT5 demo).
  // SQLite não altera CHECK: recria a tabela preservando os dados.
  `
  CREATE TABLE accounts_v3 (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    broker TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('paper','demo','live')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO accounts_v3 (id, name, broker, mode, created_at) SELECT id, name, broker, mode, created_at FROM accounts;
  DROP TABLE accounts;
  ALTER TABLE accounts_v3 RENAME TO accounts;
  `,
  // v4: bloqueio de login por usuário (tentativas erradas de qualquer IP).
  `
  ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN locked_until INTEGER NOT NULL DEFAULT 0;
  `,
];

export function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  if (current >= MIGRATIONS.length) return;
  // Recriar tabelas referenciadas exige FKs desligadas (fora da transação).
  db.pragma('foreign_keys = OFF');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v]);
        const broken = db.pragma('foreign_key_check');
        if (broken.length) throw new Error(`Migração v${v + 1} quebrou chaves estrangeiras`);
        db.pragma(`user_version = ${v + 1}`);
      })();
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
