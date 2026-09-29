import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../server/security.js';
import { ACCOUNT_IDS } from '../../bot/accounts.js';
import { STRATEGIES } from '../../bot/strategy/index.js';
import { TIMEFRAME_SECONDS } from '../../lib/util.js';
import { effectiveSettings as resolve } from '../../bot/settings.js';

export const effectiveSettings = (repo, config, accountId) => resolve(repo, config.defaults, accountId);

// Status "de fora": o bot pode estar parado/morto; o heartbeat diz se está vivo.
export function accountStatus(repo, config, accountId) {
  const account = repo.getAccount(accountId);
  const st = repo.getState(accountId);
  const control = repo.getControl(accountId);
  const staleSec = Math.max(config.priceCheckIntervalSec * 4, 60);
  const alive = !!st?.heartbeat_at && (Date.now() - Date.parse(st.heartbeat_at)) / 1000 < staleSec;
  const d = st?.data || {};
  const stats = repo.tradeStats(accountId);
  const unrealized = d.position?.unrealized_profit ?? 0;
  let status = st?.status || 'OFFLINE';
  if (status !== 'DISABLED' && !alive) status = 'OFFLINE';
  const online = status === 'RUNNING' ? 'ONLINE' : ['OFFLINE', 'FAIL_SAFE', 'EMERGENCY', 'DISABLED'].includes(status) ? 'OFFLINE' : 'PAUSED'; // IDLE/STOPPED/SYNCING -> PAUSED
  return {
    account: account && { id: account.id, name: account.name, mode: account.mode, broker: account.broker },
    status,
    indicator: online,
    reason: !alive && status === 'OFFLINE' ? 'Processo do bot sem sinal de vida' : st?.reason ?? null,
    mode: account?.mode?.toUpperCase(),
    control,
    heartbeatAt: st?.heartbeat_at ?? null,
    balance: d.valuation?.cash ?? null,
    equity: d.valuation?.equity ?? null,
    valuation: d.valuation ?? null,
    position: d.position ?? null,
    dailyPnL: d.daily?.profit_loss ?? null,
    daily: d.daily ?? null,
    totalPnL: (stats.realized || 0) + unrealized,
    realizedPnL: stats.realized || 0,
    lastSignal: d.lastSignal ?? null,
    lastTrade: d.lastTrade ?? null,
    lastAnalysisAt: st?.last_analysis_at ?? null,
    nextCheckAt: st?.next_check_at ?? null,
    lastPrice: st?.last_price ?? null,
    ticker: d.ticker ?? null,
    riskStatus: st?.risk_status ?? 'BLOCKED',
    riskReason: st?.risk_reason ?? null,
    brokerStatus: st?.broker_status ?? 'DISCONNECTED',
    symbol: d.symbol, timeframe: d.timeframe, strategy: d.strategy, strategyLabel: d.strategyLabel,
    broker: d.broker, lastError: d.lastError ?? null, lastReconcileAt: d.lastReconcileAt ?? null,
    fees: d.fees ?? null, rules: d.rules ?? null,
    tradingEnabled: config.tradingEnabled,
    tradingMode: config.tradingMode,
    liveBlockReason: account?.mode === 'live' ? config.liveBlockReason : null,
    unreadAlerts: repo.unreadAlerts(accountId),
  };
}

// Cripto (BTC-BRL) ou ação da B3 (PETR4, PETR4F)
export const SYMBOL_RE = /^([A-Z0-9]{2,12}-[A-Z]{3,5}|[A-Z]{4}\d{1,2}F?)$/;

const AccountQ = z.object({ account: z.enum(ACCOUNT_IDS).default('paper') });

// Comandos que reduzem risco são gravados direto no controle (valem mesmo
// com o bot fora do ar). Os demais vão para a fila do bot.
const CONFIRM_REQUIRED = new Set(['emergency_stop', 'clear_emergency', 'reset_paper']);
const CommandSchema = z.object({
  account: z.enum(ACCOUNT_IDS),
  command: z.enum(['start', 'pause', 'stop', 'sync', 'emergency_stop', 'clear_emergency', 'reset_paper']),
  confirm: z.boolean().optional(),
  capital: z.number().positive().max(1_000_000).optional(),
});

const pct = (min, max) => z.number().finite().min(min).max(max);
const SettingsSchema = z.object({
  account: z.enum(ACCOUNT_IDS),
  confirm: z.boolean().optional(),
  values: z.object({
    symbol: z.string().regex(SYMBOL_RE).optional(),
    timeframe: z.enum(Object.keys(TIMEFRAME_SECONDS)).optional(),
    strategy: z.enum(Object.keys(STRATEGIES)).optional(),
    strategyParams: z.record(z.string().max(40), z.number().finite().min(0).max(1000)).optional(),
    maxPositionPercent: pct(1, 100).optional(),
    maxOrderValue: z.number().finite().positive().max(1_000_000).optional(),
    maxDailyLoss: z.number().finite().min(0).max(1_000_000).optional(),
    maxDailyTrades: z.number().int().min(0).max(1000).optional(),
    stopLossPercent: pct(0.1, 50).optional(),
    takeProfitPercent: pct(0.1, 500).optional(),
    maxSpreadPercent: pct(0.01, 10).optional(),
    min24hVolume: z.number().finite().min(0).max(1e12).optional(),
    stopManageExits: z.boolean().optional(),
  }).strict(),
});

export function botRoutes({ repo, config, log }) {
  const r = Router();

  r.get('/accounts', (req, res) => {
    res.json(repo.listAccounts().map((a) => ({ ...a, status: accountStatus(repo, config, a.id) })));
  });

  r.get('/bot/status', (req, res) => {
    const { account } = validate(AccountQ, req.query);
    res.json(accountStatus(repo, config, account));
  });

  r.post('/bot/command', (req, res) => {
    const body = validate(CommandSchema, req.body);
    const by = req.session.user.username;
    const acc = repo.getAccount(body.account);
    if (!acc) return res.status(404).json({ error: 'Conta inexistente' });
    const needsConfirm = CONFIRM_REQUIRED.has(body.command) || (acc.mode === 'live' && body.command === 'start');
    if (needsConfirm && body.confirm !== true) return res.status(400).json({ error: 'Confirmação obrigatória para este comando', needsConfirm: true });
    if (body.command === 'reset_paper' && acc.mode !== 'paper') return res.status(400).json({ error: 'Reset só na conta PAPER' });
    if (body.command === 'start' && acc.mode === 'live' && config.liveBlockReason) {
      return res.status(400).json({ error: `LIVE TRADING BLOCKED: ${config.liveBlockReason}` });
    }

    const alog = log.child(body.account);
    if (body.command === 'emergency_stop') {
      repo.setControl(body.account, { desired: 'STOPPED', emergency: true }, by);
      alog.critical('SYSTEM', 'EMERGENCY_STOP', `EMERGENCY STOP pelo painel (${by}): TRADING DISABLED`);
    } else if (body.command === 'stop') {
      repo.setControl(body.account, { desired: 'STOPPED' }, by);
    } else if (body.command === 'pause') {
      repo.setControl(body.account, { desired: 'PAUSED' }, by);
    }
    const id = repo.addCommand(body.account, body.command, body.capital ? { capital: body.capital } : null, by);
    res.json({ ok: true, commandId: id });
  });

  r.get('/bot/command/:id', (req, res) => {
    const c = repo.getCommand(Number(req.params.id));
    if (!c) return res.status(404).json({ error: 'Comando não encontrado' });
    res.json({ id: c.id, command: c.command, status: c.status, result: c.result });
  });

  r.get('/settings', (req, res) => {
    const { account } = validate(AccountQ, req.query);
    res.json({
      values: effectiveSettings(repo, config, account),
      strategies: Object.entries(STRATEGIES).map(([k, v]) => ({ name: k, label: v.label, defaults: v.defaults, docs: v.docs })),
      timeframes: Object.keys(TIMEFRAME_SECONDS),
      system: {
        tradingMode: config.tradingMode, tradingEnabled: config.tradingEnabled, liveBlockReason: config.liveBlockReason,
        priceCheckIntervalSec: config.priceCheckIntervalSec, reconcileIntervalSec: config.reconcileIntervalSec,
        timezone: config.timezone, broker: config.broker.name, paperFeePercent: config.paperFeePercent,
        paperSlippagePercent: config.paperSlippagePercent, initialCapital: config.initialCapital,
      },
    });
  });

  r.put('/settings', (req, res) => {
    const body = validate(SettingsSchema, req.body);
    if (body.confirm !== true) return res.status(400).json({ error: 'Confirmação obrigatória para alterar configurações', needsConfirm: true });
    const v = body.values;
    const current = effectiveSettings(repo, config, body.account);
    const changingMarket = (v.symbol && v.symbol !== current.symbol) || (v.timeframe && v.timeframe !== current.timeframe);
    // Na XP a carteira aceita várias ações, então trocar o ativo principal só exige não ter ordem em andamento.
    if (changingMarket && ((body.account !== 'xp' && repo.anyOpenPosition(body.account).length) || repo.activeOrders(body.account).length)) {
      return res.status(409).json({ error: 'Feche a posição/ordens antes de trocar o ativo ou o timeframe' });
    }
    if (body.account === 'xp' && v.timeframe && v.timeframe !== '15m') return res.status(400).json({ error: 'A conta XP (MT5) opera apenas no timeframe 15m' });
    if (v.symbol && (body.account === 'xp') !== !v.symbol.includes('-')) {
      return res.status(400).json({ error: body.account === 'xp' ? 'Na conta XP use um código da B3 (ex.: PETR4F)' : 'Nesta conta use um par cripto (ex.: BTC-BRL)' });
    }
    if (v.strategyParams) {
      const def = STRATEGIES[v.strategy || current.strategy];
      const unknown = Object.keys(v.strategyParams).filter((k) => !(k in def.defaults));
      if (unknown.length) return res.status(400).json({ error: `Parâmetros desconhecidos: ${unknown.join(', ')}` });
      try { def.create({ ...current.strategyParams, ...v.strategyParams }); } catch (e) { return res.status(400).json({ error: e.message }); }
      v.strategyParams = { ...current.strategyParams, ...v.strategyParams };
    }
    repo.setSettings(body.account, v);
    const by = req.session.user.username;
    const changes = Object.fromEntries(Object.keys(v).map((k) => [k, { de: current[k], para: v[k] }]));
    log.child(body.account).warn('SYSTEM', 'SETTINGS_CHANGED', `Configurações alteradas por ${by}: ${Object.keys(v).join(', ')}`, changes);
    repo.addCommand(body.account, 'reload_settings', { keys: Object.keys(v) }, by);
    res.json({ ok: true, values: effectiveSettings(repo, config, body.account) });
  });

  r.get('/strategy', (req, res) => {
    const { account } = validate(AccountQ, req.query);
    const s = effectiveSettings(repo, config, account);
    const def = STRATEGIES[s.strategy];
    const st = repo.getState(account);
    res.json({
      name: s.strategy, label: def.label, params: s.strategyParams, docs: def.docs,
      symbol: s.symbol, timeframe: s.timeframe,
      lastSignal: st?.data?.lastSignal ?? null,
      signals: repo.listSignals(account, { limit: 100 }),
      note: 'confidence mede a folga das condições da estratégia; NÃO é probabilidade de lucro.',
    });
  });

  r.get('/risk', (req, res) => {
    const { account } = validate(AccountQ, req.query);
    const s = effectiveSettings(repo, config, account);
    const st = accountStatus(repo, config, account);
    const v = st.valuation;
    const used = v?.positionValue ?? 0;
    const eq = v?.equity ?? 0;
    const maxDd = repo.db.prepare('SELECT MAX(drawdown) d FROM daily_metrics WHERE account_id = ?').get(account).d || 0;
    res.json({
      status: st.riskStatus,
      reasons: st.riskReason ? st.riskReason.split('; ') : [],
      botStatus: st.status,
      botReason: st.reason,
      capitalAvailable: v?.cashAvailable ?? null,
      capitalUsed: used,
      equity: eq || null,
      exposurePercent: eq ? (used / eq) * 100 : 0,
      maxPositionPercent: s.maxPositionPercent,
      maxOrderValue: s.maxOrderValue,
      dailyPnL: st.dailyPnL,
      dailyLossLimit: s.maxDailyLoss,
      dailyLossUsedPercent: s.maxDailyLoss > 0 && st.dailyPnL < 0 ? Math.min(100, (-st.dailyPnL / s.maxDailyLoss) * 100) : 0,
      drawdownToday: st.daily?.drawdown ?? 0,
      maxDrawdown: maxDd,
      tradesToday: st.daily?.trades ?? 0,
      maxDailyTrades: s.maxDailyTrades,
      tradesRemaining: s.maxDailyTrades > 0 ? Math.max(0, s.maxDailyTrades - (st.daily?.trades ?? 0)) : null,
      stopLossPercent: s.stopLossPercent,
      takeProfitPercent: s.takeProfitPercent,
      maxSpreadPercent: s.maxSpreadPercent,
      tradingEnabled: config.tradingEnabled,
      emergency: st.control.emergency,
    });
  });

  return r;
}
