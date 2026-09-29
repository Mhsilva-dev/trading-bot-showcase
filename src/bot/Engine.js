// Engine — ciclo de uma conta (paper ou live):
//
//   Market Data -> Strategy -> Risk Manager -> Order Manager -> Broker -> Banco -> Painel
//
// Princípio de segurança:  UNKNOWN STATE -> PAUSE -> SYNC -> VERIFY -> RESUME
// Na inicialização o estado é sempre "desconhecido": nada é enviado antes
// de uma reconciliação bem-sucedida.
import { MarketData } from './market/MarketData.js';
import { createStrategy, STRATEGIES } from './strategy/index.js';
import { RiskManager, Decision } from './risk/RiskManager.js';
import { Portfolio } from './portfolio/Portfolio.js';
import { OrderManager, DuplicateGuardError } from './execution/OrderManager.js';
import { Reconciler } from './reconcile/Reconciler.js';
import { ErrorKind, asBrokerError } from '../broker/errors.js';
import { dbHealthy } from '../database/db.js';
import { floorToStep, nowIso } from '../lib/util.js';
import { effectiveSettings } from './settings.js';

const IDLE_KINDS = new Set([ErrorKind.MARKET_CLOSED, ErrorKind.NOT_CONFIGURED, ErrorKind.STARTING]);

export class Engine {
  constructor({ account, broker, repo, db, config, log, now = () => Date.now(), orderPollDelayMs, notFoundGraceMs }) {
    this.account = account;
    this.broker = broker;
    this.repo = repo;
    this.db = db;
    this.config = config;
    this.log = log;
    this.now = now;
    this.risk = new RiskManager({ maxDataAgeSec: config.maxDataAgeSec });
    this.portfolio = new Portfolio({ repo, accountId: account.id, timezone: config.timezone, log });
    this.orders = new OrderManager({ repo, broker, accountId: account.id, portfolio: this.portfolio, log, pollDelayMs: orderPollDelayMs, notFoundGraceMs });
    this.reconciler = new Reconciler({ repo, broker, orderManager: this.orders, accountId: account.id, log });

    this.needsSync = true;
    this.reconcileMismatch = null;
    this.failSafe = null;
    this.initialized = false;
    this.consecutiveErrors = 0;
    this.lastError = null;
    this.lastReconcileAt = 0;
    this.lastSnapshotAt = 0;
    this.lastExitAttemptAt = 0;
    this.lastAnalysisAt = null;
    this.lastSignal = null;
    this.lastRisk = null;
    this.haltLoggedFor = null;
    this.brokerOpenOrders = null;
    this.balances = null;
    this.valuation = null;
    this.daily = null;
    this.fees = null;
    this.md = null;
    this.strategy = null;
    this.lock = Promise.resolve();
  }

  // Serializa tick e comandos: nunca rodam em paralelo na mesma conta.
  exclusive(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  settings() {
    return effectiveSettings(this.repo, this.config.defaults, this.account.id);
  }

  ensureComponents(s) {
    if (!this.md || this.md.symbol !== s.symbol || this.md.timeframe !== s.timeframe) {
      this.md = new MarketData({ broker: this.broker, repo: this.repo, symbol: s.symbol, timeframe: s.timeframe, now: this.now });
    }
    const key = JSON.stringify([s.strategy, s.strategyParams]);
    if (!this.strategy || this.strategyKey !== key) {
      this.strategy = createStrategy(s.strategy, s.strategyParams);
      this.strategyKey = key;
    }
  }

  async init() {
    try {
      await this.broker.init();
      // Pede à ponte (MT5) os preços de todas as ações da carteira desde já.
      for (const p of this.repo.listPositions(this.account.id)) this.broker.ensureWatched?.(p.symbol);
      this.initialized = true;
      this.idleReason = null;
      this.log.info('SYSTEM', 'ENGINE_START', `Conta ${this.account.id} (${this.account.mode}) iniciada — sincronizando antes de operar`);
    } catch (e) {
      const err = asBrokerError(e);
      const idle = IDLE_KINDS.has(err.kind);
      this.idleReason = idle ? err.message : null;
      // Mesmo erro a cada ciclo: registra só quando muda.
      if (this.lastError !== err.message) {
        if (idle) this.log.info('BROKER', 'BROKER_IDLE', err.message, { kind: err.kind });
        else this.log.critical('BROKER', 'BROKER_INIT_FAILED', `Falha ao conectar na corretora: ${err.message}`, { kind: err.kind });
      }
      this.lastError = err.message;
    }
    this.saveState();
  }

  fillCtx(s, rules) {
    return { strategy: s.strategy, stopLossPercent: s.stopLossPercent, takeProfitPercent: s.takeProfitPercent, rules };
  }

  // ------------------------------------------------------------------
  tick() {
    return this.exclusive(() => this.tickUnsafe());
  }

  async tickUnsafe() {
    let s = null;
    try {
      if (!dbHealthy(this.db)) throw Object.assign(new Error('Banco indisponível'), { critical: true });
      s = this.settings();
      if (!this.initialized) await this.init();
      if (!this.initialized) return;
      this.ensureComponents(s);

      const rules = await this.md.rules();
      const ticker = await this.md.ticker();
      const ctxFill = this.fillCtx(s, rules);
      if (!this.fees || this.now() - this.fees.at > 3_600_000) this.fees = { ...(await this.broker.getFees(s.symbol)), at: this.now() };

      // Sincronização: na partida, após erro, após comando e periodicamente.
      const due = this.now() - this.lastReconcileAt > this.config.reconcileIntervalSec * 1000;
      if (this.needsSync || this.reconcileMismatch || due) await this.sync(s, rules, ticker);
      if (this.needsSync) return;

      // Estado da conta
      this.balances = await this.broker.getBalance();
      this.brokerOpenOrders = await this.broker.getOpenOrders(s.symbol);
      for (const row of this.repo.activeOrders(this.account.id)) {
        const upd = await this.orders.refresh(row, ctxFill);
        if (upd.status === 'UNKNOWN') this.needsSync = true;
      }
      if (this.needsSync) return;

      const extraValue = await this.manageExtras(s);
      this.valuation = this.portfolio.valuation(this.balances, rules, ticker, extraValue);
      const position = this.portfolio.mark(s.symbol, ticker.bid);
      this.daily = this.portfolio.updateDaily(this.valuation.equity, new Date(this.now()));
      if (this.now() - this.lastSnapshotAt >= 60_000) {
        this.repo.addEquitySnapshot(this.account.id, { balance: this.valuation.cash, equity: this.valuation.equity, positionValue: this.valuation.positionValue });
        this.lastSnapshotAt = this.now();
      }
      this.checkDailyHalt(s);

      // Saídas por stop-loss / take-profit (verificadas a cada tick)
      if (position) {
        if (ticker.bid <= position.stop_price) await this.exit(s, rules, ticker, position, 'STOP_LOSS');
        else if (ticker.bid >= position.take_profit_price) await this.exit(s, rules, ticker, position, 'TAKE_PROFIT');
      }

      // Estratégia: só quando fecha um candle novo
      const { candles, isNew } = await this.md.closedCandles(Math.max(200, this.strategy.minCandles() + 10));
      if (isNew) {
        const pos = this.portfolio.position(s.symbol);
        const sig = this.strategy.evaluate(candles, { hasPosition: !!pos });
        this.lastAnalysisAt = nowIso();
        this.lastSignal = { ...sig, at: this.lastAnalysisAt, candleTime: candles.at(-1)?.t };
        this.repo.addSignal({
          account_id: this.account.id, symbol: s.symbol, signal: sig.signal, price: sig.price, reason: sig.reason,
          confidence: sig.confidence, indicators: sig.indicators, candle_time: candles.at(-1)?.t,
        });
        this.log.info('STRATEGY', 'SIGNAL', `${sig.signal} — ${sig.reason}`, { price: sig.price, confidence: sig.confidence });
        if (sig.signal === 'BUY' && !pos) await this.enter(s, rules, ticker);
        if (sig.signal === 'SELL' && pos) await this.exit(s, rules, ticker, pos, 'SIGNAL_EXIT');
      }

      this.consecutiveErrors = 0;
      this.lastError = null;
      this.idleReason = null;
    } catch (e) {
      this.handleError(e);
    } finally {
      if (s) {
        this.lastRisk = this.riskSnapshot(s);
        this.saveState(s);
      }
    }
  }

  handleError(e) {
    const be = asBrokerError(e);
    if (IDLE_KINDS.has(be.kind)) {
      // Pregão fechado / conta sem cadastro: não é falha, mas o estado precisa
      // ser reconciliado quando voltar.
      if (this.idleReason !== be.message) this.log.info('MARKET', 'BROKER_IDLE', be.message, { kind: be.kind });
      this.idleReason = be.message;
      this.needsSync = true;
      return;
    }
    this.idleReason = null;
    if (e.critical) {
      if (this.failSafe !== e.message) this.log.critical('SYSTEM', 'FAIL_SAFE', `FAIL SAFE: ${e.message}`);
      this.failSafe = e.message;
      this.needsSync = true;
      return;
    }
    const err = asBrokerError(e);
    this.consecutiveErrors += 1;
    this.lastError = `${err.kind}: ${err.message}`;
    // Depois de qualquer falha de comunicação, o estado da conta é incerto.
    this.needsSync = true;
    if (err.kind === ErrorKind.AUTH) {
      this.failSafe = 'Erro de autenticação na corretora';
      this.log.critical('SECURITY', 'FAIL_SAFE', 'FAIL SAFE: erro de autenticação — verifique API_KEY/API_SECRET', { kind: err.kind });
    } else if (this.consecutiveErrors >= 5 && !this.failSafe) {
      this.failSafe = `${this.consecutiveErrors} erros consecutivos (${err.kind})`;
      this.log.critical('SYSTEM', 'FAIL_SAFE', `FAIL SAFE após ${this.consecutiveErrors} erros consecutivos: ${err.message}`, { kind: err.kind });
    } else {
      const ev = [ErrorKind.NETWORK, ErrorKind.TIMEOUT, ErrorKind.SERVER, ErrorKind.CIRCUIT_OPEN].includes(err.kind) ? 'BROKER_OFFLINE' : 'ERROR';
      this.log.error('ERROR', ev, `Erro no ciclo: ${err.message}`, { kind: err.kind, consecutive: this.consecutiveErrors });
    }
  }

  checkDailyHalt(s) {
    if (!this.daily || !(s.maxDailyLoss > 0)) return;
    if (this.daily.profit_loss <= -Math.abs(s.maxDailyLoss) && this.haltLoggedFor !== this.daily.date) {
      this.haltLoggedFor = this.daily.date;
      this.log.critical('RISK', 'DAILY_LOSS_HALT', `TRADING HALTED: perda do dia R$${this.daily.profit_loss.toFixed(2)} atingiu o limite de R$${s.maxDailyLoss}`);
    }
  }

  // Carteira: posições em ativos diferentes do ativo principal (compras
  // manuais). A estratégia não mexe nelas; aqui só atualiza o preço e sai
  // por stop-loss / take-profit. Devolve o valor total delas.
  async manageExtras(s) {
    let total = 0;
    this.lastExtraExitAt ||= {};
    for (const p of this.repo.listPositions(this.account.id).filter((x) => x.symbol !== s.symbol)) {
      let t;
      // Ativo ainda não publicado pela ponte (logo após reiniciar): usa o último preço.
      try { t = await this.broker.getTicker(p.symbol); } catch { total += p.quantity * (p.current_price || p.average_price); continue; }
      const pos = this.portfolio.mark(p.symbol, t.bid);
      const purpose = t.bid <= pos.stop_price ? 'STOP_LOSS' : t.bid >= pos.take_profit_price ? 'TAKE_PROFIT' : null;
      if (purpose && this.now() - (this.lastExtraExitAt[p.symbol] || 0) >= 60_000 && this.repo.getControl(this.account.id).emergency !== true) {
        this.lastExtraExitAt[p.symbol] = this.now();
        const rules = await this.broker.getSymbolRules(p.symbol);
        const qty = floorToStep(Math.min(pos.quantity, this.balances?.[rules.base]?.available ?? 0), rules.stepSize);
        if (qty > 0) {
          this.log.trade(purpose, `${purpose === 'STOP_LOSS' ? 'Stop-loss' : 'Take-profit'} em ${p.symbol}: bid ${t.bid}`);
          const r = await this.send({ symbol: p.symbol, side: 'SELL', qty, purpose }, s, rules);
          if (r?.status === 'FILLED') continue;
        }
      }
      total += pos.quantity * t.bid;
    }
    return total;
  }

  async sync(s, rules, ticker) {
    this.log.info('SYSTEM', 'SYNC_START', 'Sincronizando banco x corretora');
    const r = await this.reconciler.run({ symbol: s.symbol, rules, ticker, fillCtx: this.fillCtx(s, rules) });
    this.lastReconcileAt = this.now();
    this.brokerOpenOrders = r.brokerOpenOrders;
    this.balances = r.balances;
    this.reconcileMismatch = r.ok ? null : r.mismatches.join('; ');
    this.needsSync = !r.ok;
    if (r.ok && this.failSafe && this.failSafe !== 'Erro de autenticação na corretora' && this.manualSyncRequested) {
      this.log.warn('SYSTEM', 'FAIL_SAFE_CLEARED', `FAIL SAFE liberado após sincronização manual (${this.failSafe})`);
      this.failSafe = null;
      this.consecutiveErrors = 0;
    }
    this.manualSyncRequested = false;
    return r;
  }

  riskCtx(s, extra = {}) {
    const rules = this.md?.rulesCache?.value || null;
    return {
      account: this.account,
      global: { tradingEnabled: this.config.tradingEnabled, liveBlockReason: this.config.liveBlockReason },
      control: this.repo.getControl(this.account.id), // lido do banco a cada decisão: EMERGENCY vale na hora
      dbOk: dbHealthy(this.db),
      engine: { needsSync: this.needsSync, reconcileMismatch: this.reconcileMismatch, failSafe: this.failSafe },
      brokerHealth: this.broker.health(),
      localActiveOrders: this.repo.activeOrders(this.account.id),
      brokerOpenOrders: this.brokerOpenOrders,
      market: {
        rules,
        ticker: this.md?.lastTicker || null,
        tickerAgeSec: this.md ? this.md.tickerAgeSec() : Infinity,
        marketOpen: rules ? this.broker.isMarketOpen(rules, new Date(this.now())) : false,
        ...extra.market,
      },
      valuation: this.valuation,
      position: this.md ? this.portfolio.position(s.symbol) : null,
      daily: this.daily,
      fees: this.fees,
      settings: s,
    };
  }

  riskSnapshot(s) {
    try {
      return this.risk.status(this.riskCtx(s));
    } catch (e) {
      return { status: 'BLOCKED', reasons: [`Falha ao avaliar risco: ${e.message}`] };
    }
  }

  async enter(s, rules, ticker) {
    let orderBook = null;
    try { orderBook = await this.broker.getOrderBook(s.symbol, 20); } catch (e) {
      this.log.warn('MARKET', 'ORDERBOOK_FAILED', `Livro de ofertas indisponível: ${e.message}`);
    }
    const ctx = this.riskCtx(s, { market: { orderBook } });
    const d = this.risk.evaluateEntry(ctx);
    if (!d.allowed) {
      const label = d.decision === Decision.NO_TRADE ? 'NO TRADE' : d.decision === Decision.TRADING_HALTED ? 'TRADING HALTED' : 'TRADE BLOCKED';
      this.log.warn('RISK', d.decision, `${label}: ${d.reasons.join('; ')}`, { reasons: d.reasons });
      return;
    }
    this.log.info('RISK', 'APPROVED', `Entrada aprovada: R$${d.orderCost.toFixed(2)} (spread ${d.spreadPct.toFixed(3)}%, custo ida+volta ~${d.roundTripCostPct.toFixed(2)}%)`);
    await this.send({ symbol: s.symbol, side: 'BUY', cost: d.orderCost, purpose: 'ENTRY' }, s, rules);
  }

  async exit(s, rules, ticker, position, purpose) {
    if (this.now() - this.lastExitAttemptAt < 60_000) return; // evita martelar a corretora
    this.lastExitAttemptAt = this.now();
    const available = this.valuation?.baseAvailable ?? 0;
    const qty = floorToStep(Math.min(position.quantity, available), rules.stepSize);
    const d = this.risk.evaluateExit(this.riskCtx(s), { quantity: qty });
    if (!d.allowed) {
      this.log.warn('RISK', 'EXIT_BLOCKED', `Saída ${purpose} bloqueada: ${d.reasons.join('; ')}`, { reasons: d.reasons });
      return;
    }
    const label = purpose === 'STOP_LOSS' ? 'Stop-loss atingido' : purpose === 'TAKE_PROFIT' ? 'Take-profit atingido' : 'Sinal de saída';
    this.log.trade(purpose, `${label}: bid ${ticker.bid} (stop ${position.stop_price?.toFixed(2)}, alvo ${position.take_profit_price?.toFixed(2)})`);
    await this.send({ symbol: s.symbol, side: 'SELL', qty, purpose }, s, rules);
  }

  async send(req, s, rules) {
    try {
      const r = await this.orders.submit({ ...req, fillCtx: this.fillCtx(s, rules) });
      if (r.status === 'UNKNOWN') this.needsSync = true;
      if (r.status === 'FILLED') {
        this.balances = await this.broker.getBalance();
        this.valuation = this.portfolio.valuation(this.balances, rules, this.md.lastTicker);
      }
      if (r.status === 'FILLED' && req.side === 'SELL') {
        const t = this.repo.getTrade(r.order.trade_id);
        if (t?.status === 'CLOSED') this.log.trade('TRADE_CLOSED', `Trade #${t.id} fechado: ${t.profit_loss >= 0 ? '+' : ''}R$${t.profit_loss.toFixed(2)} (${t.exit_reason})`, { tradeId: t.id, pl: t.profit_loss });
      }
      return r;
    } catch (e) {
      if (e instanceof DuplicateGuardError) {
        this.log.warn('RISK', 'DUPLICATE_GUARD', `Ordem não enviada: ${e.message}`);
        this.needsSync = true;
        return null;
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------
  handleCommand(cmd) {
    return this.exclusive(() => this.commandUnsafe(cmd));
  }

  async commandUnsafe({ command, payload = {}, created_by: by = 'painel' }) {
    const id = this.account.id;
    switch (command) {
      case 'start': {
        const c = this.repo.getControl(id);
        if (c.emergency) throw new Error('EMERGENCY STOP ativo: libere a emergência antes de iniciar');
        this.repo.setControl(id, { desired: 'RUNNING' }, by);
        this.needsSync = true; // sempre verifica antes de voltar a operar
        this.log.info('SYSTEM', 'BOT_STARTED', `Bot iniciado por ${by} — sincronizando antes de operar`);
        return { ok: true };
      }
      case 'pause':
        this.repo.setControl(id, { desired: 'PAUSED' }, by);
        this.log.warn('SYSTEM', 'BOT_PAUSED', `Bot pausado por ${by}: novas entradas bloqueadas`);
        return { ok: true };
      case 'stop':
        this.repo.setControl(id, { desired: 'STOPPED' }, by);
        this.log.warn('SYSTEM', 'BOT_STOPPED', `Bot parado por ${by}. ${this.settings().stopManageExits ? 'Stop/take da posição aberta continuam ativos.' : 'Nenhuma ordem será enviada.'}`);
        return { ok: true };
      case 'emergency_stop':
        this.repo.setControl(id, { desired: 'STOPPED', emergency: true }, by);
        this.log.critical('SYSTEM', 'EMERGENCY_STOP', `EMERGENCY STOP acionado por ${by}: TRADING DISABLED`);
        return { ok: true };
      case 'clear_emergency':
        this.repo.setControl(id, { desired: 'STOPPED', emergency: false }, by);
        this.needsSync = true;
        this.log.warn('SYSTEM', 'EMERGENCY_CLEARED', `Emergência liberada por ${by}. Bot permanece PARADO até ser iniciado.`);
        return { ok: true };
      case 'sync':
        this.needsSync = true;
        this.manualSyncRequested = true;
        this.log.info('SYSTEM', 'SYNC_REQUESTED', `Sincronização solicitada por ${by}`);
        return { ok: true };
      case 'reload_settings':
        this.strategy = null;
        this.log.info('SYSTEM', 'SETTINGS_RELOADED', `Configurações recarregadas (${by})`, payload);
        return { ok: true };
      case 'reset_paper':
        return this.resetPaper(by, payload.capital);
      case 'manual_buy': {
        // Compra de teste com quantidade fixa: só em PAPER/DEMO, nunca em conta real.
        if (this.account.mode === 'live') throw new Error('Compra manual não é permitida na conta real');
        const qty = Math.floor(Number(payload.qty));
        if (!(qty >= 1 && qty <= 100)) throw new Error('Quantidade inválida (1 a 100)');
        const s = this.settings();
        // Outro ativo além do principal: só na conta XP (carteira de ações).
        const symbol = payload.symbol || s.symbol;
        if (symbol !== s.symbol && this.account.id !== 'xp') throw new Error('Compra de outro ativo só na conta XP');
        if (this.portfolio.position(symbol)) throw new Error(`Já existe posição aberta em ${symbol}`);
        const rules = await this.broker.getSymbolRules(symbol);
        const ticker = await this.broker.getTicker(symbol);
        this.log.trade('MANUAL_BUY', `Compra manual de ${qty} ${symbol} por ${by} (ask ${ticker.ask})`);
        // cost entre qty e qty+1 ações: o broker arredonda para baixo pelo ask
        const r = await this.send({ symbol, side: 'BUY', cost: ticker.ask * (qty + 0.5), purpose: 'ENTRY' }, s, rules);
        return { ok: r?.status === 'FILLED', status: r?.status };
      }
      default:
        throw new Error(`Comando desconhecido: ${command}`);
    }
  }

  resetPaper(by, capital) {
    if (this.account.mode !== 'paper' || typeof this.broker.reset !== 'function') throw new Error('Reset só é permitido na conta PAPER');
    const c = this.repo.getControl(this.account.id);
    if (c.desired === 'RUNNING') throw new Error('Pare o bot antes de resetar o paper trading');
    const id = this.account.id;
    this.repo.tx(() => {
      for (const t of ['orders', 'trades', 'positions', 'strategy_signals', 'equity_snapshots', 'daily_metrics']) {
        this.db.prepare(`DELETE FROM ${t} WHERE account_id = ?`).run(id);
      }
      this.broker.reset(capital ?? this.config.initialCapital);
    });
    this.valuation = null;
    this.daily = null;
    this.needsSync = true;
    this.lastSnapshotAt = 0;
    this.log.warn('SYSTEM', 'PAPER_RESET', `Paper trading resetado por ${by} (capital R$${capital ?? this.config.initialCapital})`);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  displayStatus() {
    const c = this.repo.getControl(this.account.id);
    if (c.emergency) return { status: 'EMERGENCY', reason: 'EMERGENCY STOP ativo — TRADING DISABLED' };
    if (this.failSafe) return { status: 'FAIL_SAFE', reason: `FAIL SAFE: ${this.failSafe}` };
    if (this.idleReason) return { status: 'IDLE', reason: this.idleReason };
    if (!this.initialized) return { status: 'BLOCKED', reason: this.lastError || 'Conectando à corretora' };
    if (this.reconcileMismatch) return { status: 'PAUSED', reason: `TRADING PAUSED: ${this.reconcileMismatch}` };
    if (this.needsSync) return { status: 'SYNCING', reason: this.lastError ? `Aguardando sincronização após erro: ${this.lastError}` : 'Sincronizando com a corretora' };
    if (c.desired === 'STOPPED') return { status: 'STOPPED', reason: 'Bot parado' };
    if (c.desired === 'PAUSED') return { status: 'PAUSED', reason: 'Bot pausado pelo operador' };
    if (this.lastRisk?.status === 'HALTED') return { status: 'HALTED', reason: 'TRADING HALTED: limite de perda diária atingido' };
    return { status: 'RUNNING', reason: null };
  }

  saveState(settings) {
    try {
      const s = settings || this.settings();
      const st = this.displayStatus();
      const pos = this.md ? this.portfolio.position(s.symbol) : null;
      const lastTrade = this.repo.listExecutions({ accountId: this.account.id, limit: 1 }).rows[0] || null;
      const health = this.broker.health();
      this.repo.saveState(this.account.id, {
        status: st.status,
        reason: st.reason,
        riskStatus: this.lastRisk?.status,
        riskReason: this.lastRisk?.reasons?.join('; ') || null,
        brokerStatus: health.ok ? 'CONNECTED' : 'DISCONNECTED',
        lastAnalysisAt: this.lastAnalysisAt,
        nextCheckAt: new Date(this.now() + this.config.priceCheckIntervalSec * 1000).toISOString(),
        lastSignal: this.lastSignal?.signal ?? null,
        lastPrice: this.md?.lastTicker?.last ?? null,
        data: {
          mode: this.account.mode,
          broker: this.broker.name,
          symbol: s.symbol,
          timeframe: s.timeframe,
          strategy: s.strategy,
          strategyLabel: STRATEGIES[s.strategy]?.label,
          ticker: this.md?.lastTicker ? { bid: this.md.lastTicker.bid, ask: this.md.lastTicker.ask, last: this.md.lastTicker.last, ts: this.md.lastTicker.ts } : null,
          valuation: this.valuation,
          daily: this.daily,
          position: pos,
          lastSignal: this.lastSignal,
          lastTrade,
          risk: this.lastRisk,
          circuit: health.circuit,
          brokerMessage: health.message || null,
          lastError: this.lastError,
          lastReconcileAt: this.lastReconcileAt ? new Date(this.lastReconcileAt).toISOString() : null,
          fees: this.fees ? { maker: this.fees.maker, taker: this.fees.taker } : null,
          rules: this.md?.rulesCache?.value ? { minCost: this.md.rulesCache.value.minCost, minVolume: this.md.rulesCache.value.minVolume, base: this.md.rulesCache.value.base, quote: this.md.rulesCache.value.quote } : null,
        },
      });
    } catch (e) {
      process.stderr.write(`falha ao salvar estado: ${e.message}\n`);
    }
  }
}
