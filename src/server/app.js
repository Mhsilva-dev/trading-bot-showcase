import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import { rateLimit } from 'express-rate-limit';
import { SqliteSessionStore } from './sessionStore.js';
import { requireAuth, csrfProtection } from './security.js';
import { authRoutes } from '../api/routes/auth.js';
import { botRoutes, accountStatus } from '../api/routes/bot.js';
import { dataRoutes } from '../api/routes/data.js';
import { backtestRoutes } from '../api/routes/backtest.js';
import { connectionRoutes } from '../api/routes/connections.js';
import { dbHealthy } from '../database/db.js';
import { ROOT_DIR } from '../config/index.js';

export function createApp({ db, repo, config, log, marketData, staticDir = path.join(ROOT_DIR, 'web/dist') }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // atrás do nginx: IP real e cookie secure

  let secret = config.dashboard.sessionSecret;
  if (!secret || secret.length < 32) {
    if (config.nodeEnv === 'production') throw new Error('JWT_SECRET ausente ou curto (mín. 32 caracteres) — defina no .env');
    secret = crypto.randomBytes(32).toString('hex');
    log.warn('SECURITY', 'EPHEMERAL_SECRET', 'JWT_SECRET não definido: usando segredo temporário (sessões caem ao reiniciar)');
  }

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'ws:', 'wss:'],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': config.dashboard.cookieSecure ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.dashboard.cookieSecure,
  }));

  // Health check público, sem dados sensíveis.
  app.get('/health', (req, res) => {
    const dbOk = dbHealthy(db);
    let bot = 'offline';
    let broker = 'disconnected';
    let trading = false;
    if (dbOk) {
      const st = accountStatus(repo, config, 'paper');
      const live = config.tradingMode === 'live' ? accountStatus(repo, config, 'live') : null;
      const main = live || st;
      bot = st.status === 'OFFLINE' ? 'offline' : 'online';
      broker = main.brokerStatus === 'CONNECTED' ? 'connected' : 'disconnected';
      trading = config.tradingEnabled && [st, live].some((a) => a && a.status === 'RUNNING');
    }
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ok' : 'degraded', bot, database: dbOk ? 'connected' : 'unavailable', broker, trading });
  });

  const sessionMiddleware = session({
    name: 'tb.sid',
    secret,
    store: new SqliteSessionStore(db),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', secure: config.dashboard.cookieSecure, maxAge: 12 * 3600 * 1000 },
  });

  app.use('/api', express.json({ limit: '6mb' }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use('/api', sessionMiddleware);
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api/auth', authRoutes({ repo, log }));
  app.use('/api', requireAuth, csrfProtection);
  app.use('/api', botRoutes({ repo, config, log }));
  app.use('/api', dataRoutes({ repo, config }));
  app.use('/api', backtestRoutes({ repo, marketData, log }));
  app.use('/api', connectionRoutes({ repo, config, log }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

  // Frontend (build do Vite)
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|ws|health).*/, (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // Erros: mensagem genérica para o cliente, detalhe só no log.
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error('ERROR', 'API_ERROR', `${req.method} ${req.path}: ${err.message}`);
    const safe = status < 500 || err.kind ? err.message : 'Erro interno';
    res.status(status).json({ error: safe });
  });

  return { app, sessionMiddleware };
}
