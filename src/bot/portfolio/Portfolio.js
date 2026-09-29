// Portfolio Manager: transforma execuções em trades/posições e calcula
// saldo, patrimônio, P/L e métricas diárias. Toda escrita é transacional.
import { dayKey, round } from '../../lib/util.js';

export class Portfolio {
  constructor({ repo, accountId, timezone = 'America/Sao_Paulo', log }) {
    this.repo = repo;
    this.accountId = accountId;
    this.tz = timezone;
    this.log = log;
  }

  // Patrimônio a partir dos saldos da corretora (fonte da verdade).
  // `extraValue` = valor das posições em outros ativos (carteira da conta XP).
  valuation(balances, rules, ticker, extraValue = 0) {
    const q = balances[rules.quote] || { available: 0, onHold: 0, total: 0 };
    const b = balances[rules.base] || { available: 0, onHold: 0, total: 0 };
    const positionValue = b.total * ticker.bid + extraValue; // valor de venda imediata
    return {
      cash: q.total,
      cashAvailable: q.available,
      baseQty: b.total,
      baseAvailable: b.available,
      positionValue,
      equity: q.total + positionValue,
    };
  }

  position(symbol) {
    return this.repo.openPosition(this.accountId, symbol);
  }

  // Aplica uma execução (total ou incremental) vinda da corretora.
  // `delta` = { qty, avgPrice, feeBase, feeQuote } apenas da parte NOVA executada.
  applyFill(order, delta, { strategy, stopLossPercent, takeProfitPercent, rules }) {
    return this.repo.tx(() => {
      if (order.side === 'BUY') return this.applyBuy(order, delta, { strategy, stopLossPercent, takeProfitPercent });
      return this.applySell(order, delta, { rules });
    });
  }

  applyBuy(order, d, { strategy, stopLossPercent, takeProfitPercent }) {
    const netQty = d.qty - d.feeBase;
    const cost = d.qty * d.avgPrice;
    const feeValue = d.feeBase * d.avgPrice + d.feeQuote;
    const pos = this.position(order.symbol);
    if (pos) {
      // Execução adicional de uma mesma entrada (parcial) -> preço médio ponderado.
      const trade = this.repo.getTrade(pos.trade_id);
      const qty = pos.quantity + netQty;
      const entryCost = trade.entry_cost + cost + d.feeQuote;
      const avg = (trade.entry_price * trade.quantity + d.avgPrice * netQty) / qty;
      this.repo.updateTrade(trade.id, { quantity: qty, entry_cost: entryCost, entry_price: avg, fees: trade.fees + feeValue });
      this.repo.updatePosition(pos.id, {
        quantity: qty, average_price: avg,
        stop_price: avg * (1 - stopLossPercent / 100), take_profit_price: avg * (1 + takeProfitPercent / 100),
      });
      return { tradeId: trade.id };
    }
    const trade = this.repo.openTrade({
      account_id: this.accountId, symbol: order.symbol, entry_price: d.avgPrice, quantity: netQty,
      entry_cost: cost + d.feeQuote, fees: feeValue, strategy, entry_order_id: order.id,
    });
    this.repo.createPosition({
      account_id: this.accountId, symbol: order.symbol, quantity: netQty, average_price: d.avgPrice,
      stop_price: d.avgPrice * (1 - stopLossPercent / 100), take_profit_price: d.avgPrice * (1 + takeProfitPercent / 100),
      trade_id: trade.id,
    });
    return { tradeId: trade.id };
  }

  applySell(order, d, { rules }) {
    const pos = this.position(order.symbol);
    if (!pos) {
      this.log?.critical('TRADE', 'SELL_WITHOUT_POSITION', 'Venda executada sem posição local — reconciliação necessária', { orderId: order.id });
      return { tradeId: null, mismatch: true };
    }
    const trade = this.repo.getTrade(pos.trade_id);
    const proceeds = d.qty * d.avgPrice - d.feeQuote - d.feeBase * d.avgPrice;
    const feeValue = d.feeQuote + d.feeBase * d.avgPrice;
    const remaining = round(pos.quantity - d.qty, 12);
    const exitQty = trade.exit_qty + d.qty;
    const exitProceeds = trade.exit_proceeds + proceeds;
    const fees = trade.fees + feeValue;
    // Sobra menor que o mínimo negociável = "poeira": fecha o trade.
    const dust = remaining <= 0 || remaining < rules.minVolume || remaining * d.avgPrice < rules.minCost;
    if (dust) {
      const pl = exitProceeds - trade.entry_cost;
      this.repo.updateTrade(trade.id, { exit_qty: exitQty, exit_proceeds: exitProceeds });
      const closed = this.repo.closeTrade(trade.id, {
        exit_price: exitProceeds / exitQty, fees, profit_loss: pl, exit_reason: order.purpose, exit_order_id: order.id,
      });
      this.repo.updatePosition(pos.id, { quantity: Math.max(remaining, 0), status: 'CLOSED', unrealized_profit: 0, current_price: d.avgPrice });
      return { tradeId: trade.id, closed, dust: remaining > 0 ? remaining : 0 };
    }
    this.repo.updateTrade(trade.id, { exit_qty: exitQty, exit_proceeds: exitProceeds, fees });
    this.repo.updatePosition(pos.id, { quantity: remaining });
    return { tradeId: trade.id, partial: true };
  }

  mark(symbol, bid) {
    const pos = this.position(symbol);
    if (!pos) return null;
    const trade = this.repo.getTrade(pos.trade_id);
    const costBasis = trade ? trade.entry_cost * (pos.quantity / trade.quantity) : pos.quantity * pos.average_price;
    const unrealized = pos.quantity * bid - costBasis;
    this.repo.updatePosition(pos.id, { current_price: bid, unrealized_profit: unrealized });
    return { ...pos, current_price: bid, unrealized_profit: unrealized, unrealized_percent: costBasis ? (unrealized / costBasis) * 100 : 0 };
  }

  // Atualiza a linha de métricas do dia e devolve o P/L do dia.
  updateDaily(equity, now = new Date()) {
    const date = dayKey(now, this.tz);
    const startOfDayIso = this.startOfDayIso(now);
    let row = this.repo.getDaily(this.accountId, date);
    const closed = this.repo.closedTradesSince(this.accountId, startOfDayIso);
    const entries = this.repo.entriesSince(this.accountId, startOfDayIso);
    const starting = row ? row.starting_balance : equity;
    const peak = Math.max(row ? row.peak_balance : equity, equity);
    const drawdown = peak > 0 ? Math.max(row ? row.drawdown : 0, ((peak - equity) / peak) * 100) : 0;
    row = {
      starting_balance: starting,
      ending_balance: equity,
      peak_balance: peak,
      profit_loss: equity - starting,
      fees: closed.reduce((s, t) => s + t.fees, 0),
      trades: entries,
      wins: closed.filter((t) => t.profit_loss > 0).length,
      losses: closed.filter((t) => t.profit_loss <= 0).length,
      drawdown,
    };
    this.repo.upsertDaily(this.accountId, date, row);
    return { date, ...row };
  }

  // Meia-noite no fuso configurado, em ISO UTC.
  startOfDayIso(now = new Date()) {
    const date = dayKey(now, this.tz);
    // Descobre o offset do fuso naquele instante.
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: this.tz, timeZoneName: 'longOffset' });
    const off = fmt.formatToParts(now).find((p) => p.type === 'timeZoneName').value; // "GMT-03:00"
    const m = off.match(/GMT([+-]\d{2}):?(\d{2})?/);
    const offset = m ? `${m[1]}:${m[2] || '00'}` : 'Z';
    return new Date(`${date}T00:00:00${offset}`).toISOString();
  }
}
