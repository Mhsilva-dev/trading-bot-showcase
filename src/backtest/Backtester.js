// Backtest — simula a estratégia sobre candles históricos com as MESMAS
// regras do bot: sinal no fechamento do candle i, execução na ABERTURA do
// candle i+1 (sem olhar o futuro), taxas, slippage, stop-loss e take-profit.
//
// Stop/take intra-candle: se no mesmo candle a mínima tocar o stop e a
// máxima tocar o alvo, assume-se o STOP (hipótese conservadora).
//
// Resultados históricos NÃO garantem resultados futuros.
import { createStrategy } from '../bot/strategy/index.js';

export function runBacktest({
  candles, strategy = 'ema_rsi', strategyParams = {}, capital = 20, feePercent = 0.7, slippagePercent = 0.05,
  stopLossPercent = 2, takeProfitPercent = 3, maxOrderValue = Infinity, maxPositionPercent = 100, minCost = 0,
}) {
  if (!Array.isArray(candles) || candles.length < 10) throw new Error('Candles insuficientes para o backtest');
  const strat = createStrategy(strategy, strategyParams);
  const window = Math.max(200, strat.minCandles() + 10); // mesmo tamanho de janela do bot ao vivo
  const fee = feePercent / 100;
  const slip = slippagePercent / 100;

  let cash = capital;
  let pos = null; // { qty, entryPrice, entryCost, fees, stop, take, openedAt }
  let pending = null; // 'BUY' | 'SELL'
  let feesTotal = 0;
  const trades = [];
  const equity = [];
  const markers = [];
  let peak = capital;
  let maxDd = 0;

  const close = (c, price, reason) => {
    const gross = pos.qty * price;
    const f = gross * fee;
    feesTotal += f;
    cash += gross - f;
    const pl = gross - f - pos.entryCost;
    trades.push({
      openedAt: pos.openedAt, closedAt: c.t, entryPrice: pos.entryPrice, exitPrice: price, quantity: pos.qty,
      fees: pos.fees + f, profitLoss: pl, profitLossPercent: (pl / pos.entryCost) * 100, reason,
    });
    markers.push({ t: c.t, side: 'SELL', price, reason });
    pos = null;
  };

  const start = strat.minCandles() - 1;
  for (let j = start; j < candles.length; j++) {
    const c = candles[j];

    // 1. ordem decidida no candle anterior executa na abertura deste
    if (pending === 'BUY' && !pos) {
      const price = c.o * (1 + slip);
      const cost = Math.min(cash, cash * (maxPositionPercent / 100), maxOrderValue);
      if (cost >= minCost && cost > 0) {
        const grossQty = cost / price;
        const f = grossQty * fee; // taxa no ativo recebido, como na corretora
        feesTotal += f * price;
        cash -= cost;
        pos = { qty: grossQty - f, entryPrice: price, entryCost: cost, fees: f * price, stop: price * (1 - stopLossPercent / 100), take: price * (1 + takeProfitPercent / 100), openedAt: c.t };
        markers.push({ t: c.t, side: 'BUY', price });
      }
    } else if (pending === 'SELL' && pos) {
      close(c, c.o * (1 - slip), 'SIGNAL_EXIT');
    }
    pending = null;

    // 2. stop-loss / take-profit dentro do candle
    if (pos) {
      if (c.l <= pos.stop) close(c, Math.min(c.o, pos.stop) * (1 - slip), 'STOP_LOSS');
      else if (c.h >= pos.take) close(c, Math.max(c.o, pos.take) * (1 - slip), 'TAKE_PROFIT');
    }

    // 3. sinal no fechamento
    const hist = candles.slice(Math.max(0, j + 1 - window), j + 1);
    const sig = strat.evaluate(hist, { hasPosition: !!pos });
    if (sig.signal === 'BUY' && !pos) pending = 'BUY';
    if (sig.signal === 'SELL' && pos) pending = 'SELL';

    const eq = cash + (pos ? pos.qty * c.c * (1 - fee) : 0);
    peak = Math.max(peak, eq);
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    maxDd = Math.max(maxDd, dd);
    equity.push({ t: c.t, equity: eq, pnl: eq - capital, drawdown: -dd });
  }

  // posição aberta no fim é encerrada no último fechamento (marcação a mercado)
  if (pos) close(candles.at(-1), candles.at(-1).c * (1 - slip), 'END_OF_DATA');
  const finalCapital = cash;
  const wins = trades.filter((t) => t.profitLoss > 0);
  const losses = trades.filter((t) => t.profitLoss <= 0);
  if (equity.length) {
    equity.at(-1).equity = finalCapital;
    equity.at(-1).pnl = finalCapital - capital;
  }
  return {
    summary: {
      initialCapital: capital,
      finalCapital,
      profitLoss: finalCapital - capital,
      profitLossPercent: ((finalCapital - capital) / capital) * 100,
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
      fees: feesTotal,
      maxDrawdownPercent: maxDd,
      biggestWin: wins.length ? Math.max(...wins.map((t) => t.profitLoss)) : 0,
      biggestLoss: losses.length ? Math.min(...losses.map((t) => t.profitLoss)) : 0,
      candles: candles.length,
      from: candles[0].t,
      to: candles.at(-1).t,
    },
    trades,
    equity,
    markers,
    disclaimer: 'Resultados históricos não garantem resultados futuros.',
  };
}

// CSV: colunas t|time|date, o|open, h|high, l|low, c|close, v|volume (cabeçalho obrigatório).
export function parseCandlesCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV vazio');
  const sep = lines[0].includes(';') ? ';' : ',';
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const idx = (names) => head.findIndex((h) => names.includes(h));
  const cols = { t: idx(['t', 'time', 'date', 'timestamp', 'data']), o: idx(['o', 'open', 'abertura']), h: idx(['h', 'high', 'maxima', 'máxima']), l: idx(['l', 'low', 'minima', 'mínima']), c: idx(['c', 'close', 'fechamento']), v: idx(['v', 'volume']) };
  for (const k of ['t', 'o', 'h', 'l', 'c']) if (cols[k] < 0) throw new Error(`Coluna obrigatória ausente no CSV: ${k}`);
  const out = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const p = line.split(sep);
    const rawT = p[cols.t].trim();
    const t = /^\d+$/.test(rawT) ? (rawT.length > 11 ? Math.floor(Number(rawT) / 1000) : Number(rawT)) : Math.floor(Date.parse(rawT) / 1000);
    const k = { t, o: Number(p[cols.o]), h: Number(p[cols.h]), l: Number(p[cols.l]), c: Number(p[cols.c]), v: cols.v >= 0 ? Number(p[cols.v]) : 0 };
    if (!Number.isFinite(k.t) || ![k.o, k.h, k.l, k.c].every((x) => Number.isFinite(x) && x > 0)) throw new Error(`Linha inválida no CSV: ${line.slice(0, 80)}`);
    out.push(k);
  }
  if (out.length > 50_000) throw new Error('CSV grande demais (máx. 50.000 candles)');
  return out.sort((a, b) => a.t - b.t);
}
