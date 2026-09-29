// npm run backtest -- --symbol=BTC-BRL --timeframe=15m --days=30 --capital=20 --fee=0.7 --sl=2 --tp=3
// npm run backtest -- --csv=arquivo.csv --capital=20
import fs from 'node:fs';
import { MercadoBitcoinBroker } from '../broker/MercadoBitcoinBroker.js';
import { runBacktest, parseCandlesCsv } from '../backtest/Backtester.js';
import { TIMEFRAME_SECONDS } from '../lib/util.js';
import { config } from '../config/index.js';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const symbol = arg('symbol', 'BTC-BRL');
const timeframe = arg('timeframe', '15m');
const days = Number(arg('days', '30'));
const csv = arg('csv');

let candles;
if (csv) {
  candles = parseCandlesCsv(fs.readFileSync(csv, 'utf8'));
} else {
  const to = Math.floor(Date.now() / 1000);
  candles = await new MercadoBitcoinBroker({ baseUrl: config.broker.baseUrl })
    .getCandlesRange(symbol, timeframe, to - days * 86400, to, TIMEFRAME_SECONDS[timeframe]);
}

const r = runBacktest({
  candles,
  capital: Number(arg('capital', '20')),
  feePercent: Number(arg('fee', String(config.paperFeePercent))),
  slippagePercent: Number(arg('slippage', String(config.paperSlippagePercent))),
  stopLossPercent: Number(arg('sl', String(config.defaults.stopLossPercent))),
  takeProfitPercent: Number(arg('tp', String(config.defaults.takeProfitPercent))),
  minCost: 0.9,
});
const s = r.summary;
const f = (n) => n.toFixed(2);
console.log(`\nBACKTEST ${csv || `${symbol} ${timeframe} ${days}d`} — ${s.candles} candles`);
console.log(`Capital inicial  R$${f(s.initialCapital)}`);
console.log(`Capital final    R$${f(s.finalCapital)}`);
console.log(`P/L              R$${f(s.profitLoss)} (${f(s.profitLossPercent)}%)`);
console.log(`Trades           ${s.trades}  (wins ${s.wins} / losses ${s.losses}, win rate ${f(s.winRate)}%)`);
console.log(`Taxas            R$${f(s.fees)}`);
console.log(`Drawdown máximo  ${f(s.maxDrawdownPercent)}%`);
console.log(`Maior ganho      R$${f(s.biggestWin)}   Maior perda R$${f(s.biggestLoss)}`);
console.log(`\n${r.disclaimer}`);
