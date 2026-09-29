// Risk Manager — decide se uma ordem PODE ser enviada. Não sabe nada de
// estratégia nem de corretora: recebe um contexto já coletado e aplica regras.
//
// Decisões:
//   APPROVED        pode enviar
//   TRADE_BLOCKED   condição insegura (estado desconhecido, API, spread...)
//   NO_TRADE        não há como operar dentro das regras (saldo/mínimos)
//   TRADING_HALTED  limite de perda diária atingido
//
// Princípio: na dúvida, NÃO operar. Qualquer dado ausente = bloqueio.

export const Decision = {
  APPROVED: 'APPROVED',
  TRADE_BLOCKED: 'TRADE_BLOCKED',
  NO_TRADE: 'NO_TRADE',
  TRADING_HALTED: 'TRADING_HALTED',
};

export class RiskManager {
  constructor({ maxDataAgeSec = 90 } = {}) {
    this.maxDataAgeSec = maxDataAgeSec;
  }

  // Checagens de segurança comuns a entrada e saída.
  safetyChecks(ctx, { forExit = false } = {}) {
    const r = [];
    if (!ctx.global?.tradingEnabled) r.push('Kill switch: TRADING_ENABLED=false');
    if (ctx.account?.mode === 'live' && ctx.global?.liveBlockReason) r.push(`LIVE TRADING BLOCKED: ${ctx.global.liveBlockReason}`);
    if (ctx.control?.emergency) r.push('EMERGENCY STOP ativo');
    if (!ctx.dbOk) r.push('Banco de dados indisponível');
    if (ctx.engine?.failSafe) r.push(`FAIL SAFE: ${ctx.engine.failSafe}`);
    if (ctx.engine?.needsSync) r.push('Estado desconhecido: sincronização pendente');
    if (ctx.engine?.reconcileMismatch) r.push(`Reconciliação divergente: ${ctx.engine.reconcileMismatch}`);
    if (!ctx.brokerHealth?.ok) r.push(`API da corretora indisponível${ctx.brokerHealth?.message ? `: ${ctx.brokerHealth.message}` : ''}`);
    if (ctx.localActiveOrders?.length) r.push(`Há ${ctx.localActiveOrders.length} ordem(ns) em andamento no banco`);
    if (ctx.brokerOpenOrders === undefined || ctx.brokerOpenOrders === null) r.push('Ordens abertas na corretora desconhecidas');
    else if (ctx.brokerOpenOrders.length) r.push(`Há ${ctx.brokerOpenOrders.length} ordem(ns) aberta(s) na corretora`);

    const m = ctx.market;
    if (!m?.rules) r.push('Regras do ativo desconhecidas');
    if (!m?.ticker) r.push('Preço atual desconhecido');
    else if (!(m.tickerAgeSec <= this.maxDataAgeSec)) r.push(`Preço desatualizado (${Math.round(m.tickerAgeSec)}s)`);
    if (m?.rules && !m.marketOpen) r.push('Mercado fechado ou ativo não negociável');
    if (!ctx.valuation) r.push('Saldo desconhecido');

    if (!forExit) {
      if (ctx.control?.desired !== 'RUNNING') r.push(`Bot não está em execução (${ctx.control?.desired || '?'})`);
    }
    return r;
  }

  evaluateEntry(ctx) {
    const s = ctx.settings;
    const reasons = this.safetyChecks(ctx);
    if (reasons.length) return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons };

    // Limite de perda diária
    const dailyPnl = ctx.daily?.profit_loss ?? null;
    if (dailyPnl === null) return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons: ['P/L diário desconhecido'] };
    if (s.maxDailyLoss > 0 && dailyPnl <= -Math.abs(s.maxDailyLoss)) {
      return { allowed: false, decision: Decision.TRADING_HALTED, reasons: [`Limite diário atingido: P/L ${dailyPnl.toFixed(2)} <= -${Math.abs(s.maxDailyLoss).toFixed(2)}`] };
    }
    if (s.maxDailyTrades > 0 && (ctx.daily?.trades ?? 0) >= s.maxDailyTrades) {
      return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons: [`Máximo de ${s.maxDailyTrades} operações no dia atingido`] };
    }

    // Posição / exposição
    if (ctx.position) return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons: ['Já existe posição aberta neste ativo'] };
    const { rules, ticker } = ctx.market;
    const v = ctx.valuation;
    const minCostValue = rules.minCost;
    if (v.baseQty * ticker.bid >= minCostValue) {
      return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons: [`Corretora mostra ${v.baseQty} ${rules.base} sem posição local — sincronizar`] };
    }

    // Spread e liquidez
    const mid = (ticker.bid + ticker.ask) / 2;
    const spreadPct = ((ticker.ask - ticker.bid) / mid) * 100;
    if (spreadPct > s.maxSpreadPercent) {
      return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons: [`Spread ${spreadPct.toFixed(3)}% acima do máximo ${s.maxSpreadPercent}%`] };
    }
    if (s.min24hVolume > 0 && !(ticker.quoteVolume >= s.min24hVolume)) {
      return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons: [`Liquidez baixa: volume 24h ${Math.round(ticker.quoteVolume)} < ${s.min24hVolume}`] };
    }

    // Tamanho da ordem
    const takerFee = ctx.fees?.taker;
    if (takerFee === undefined || takerFee === null) return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons: ['Taxa da corretora desconhecida'] };
    const byExposure = v.equity * (s.maxPositionPercent / 100);
    let cost = Math.min(v.cashAvailable, byExposure, s.maxOrderValue);
    cost = Math.floor(cost * 100) / 100; // centavos, para baixo
    if (cost < minCostValue) {
      return { allowed: false, decision: Decision.NO_TRADE, reasons: [`Valor disponível para a ordem (R$${cost.toFixed(2)}) abaixo do mínimo da corretora (R$${minCostValue.toFixed(2)})`] };
    }
    if (cost > rules.maxCost) cost = rules.maxCost;
    const qty = cost / ticker.ask;
    if (qty < rules.minVolume) {
      return { allowed: false, decision: Decision.NO_TRADE, reasons: [`Quantidade ${qty} abaixo do mínimo ${rules.minVolume} ${rules.base}`] };
    }
    // Depois de comprar, a posição inteira precisa poder ser vendida (mínimos na saída).
    const netQty = qty * (1 - takerFee);
    const exitValue = netQty * ticker.bid * (1 - s.stopLossPercent / 100);
    if (netQty < rules.minVolume || exitValue < minCostValue) {
      return { allowed: false, decision: Decision.NO_TRADE, reasons: ['Posição resultante ficaria abaixo do mínimo para venda'] };
    }

    // Liquidez no livro: o topo precisa comportar a ordem com folga.
    if (ctx.market.orderBook) {
      const depth = ctx.market.orderBook.asks.slice(0, 10).reduce((sum, [p, q]) => sum + p * q, 0);
      if (depth < cost * 2) return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons: [`Livro raso: R$${depth.toFixed(2)} nos 10 primeiros níveis`] };
    } else {
      return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons: ['Livro de ofertas indisponível'] };
    }

    // O alvo precisa pagar pelo menos os custos (taxa de entrada + saída + spread).
    const roundTripCostPct = takerFee * 2 * 100 + spreadPct;
    if (s.takeProfitPercent <= roundTripCostPct) {
      return { allowed: false, decision: Decision.NO_TRADE, reasons: [`Take profit ${s.takeProfitPercent}% não cobre os custos estimados ${roundTripCostPct.toFixed(2)}%`] };
    }

    return { allowed: true, decision: Decision.APPROVED, reasons: [], orderCost: cost, spreadPct, roundTripCostPct };
  }

  // Saída (stop/take/sinal). Mais permissiva que a entrada — reduzir risco
  // deve ser possível mesmo com o bot parado — mas nunca em estado desconhecido.
  evaluateExit(ctx, { quantity }) {
    const reasons = this.safetyChecks(ctx, { forExit: true });
    const allowExitWhenStopped = ctx.settings.stopManageExits;
    if (ctx.control?.desired !== 'RUNNING' && !allowExitWhenStopped) reasons.push('Bot parado e STOP_MANAGE_EXITS=false');
    if (reasons.length) return { allowed: false, decision: Decision.TRADE_BLOCKED, reasons };
    const { rules, ticker } = ctx.market;
    if (!(quantity >= rules.minVolume) || quantity * ticker.bid < rules.minCost) {
      return { allowed: false, decision: Decision.NO_TRADE, reasons: ['Quantidade da posição abaixo do mínimo para venda'] };
    }
    return { allowed: true, decision: Decision.APPROVED, reasons: [] };
  }

  // Resumo para o painel (sem sinal específico).
  status(ctx) {
    const reasons = this.safetyChecks(ctx);
    const s = ctx.settings;
    if (!reasons.length && ctx.daily && s.maxDailyLoss > 0 && ctx.daily.profit_loss <= -Math.abs(s.maxDailyLoss)) {
      return { status: 'HALTED', reasons: ['Limite diário atingido'] };
    }
    if (reasons.length) return { status: 'BLOCKED', reasons };
    return { status: 'NORMAL', reasons: [] };
  }
}
