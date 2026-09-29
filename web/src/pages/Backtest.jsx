import { useState } from 'react';
import { FlaskConical, Upload, TriangleAlert } from 'lucide-react';
import { api } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { Card, Field, Button, Stat, Table, ErrorBox, Segmented, Select, inputCls, sideBadge } from '../components/ui.jsx';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.jsx';
import { CandleChart } from '../charts/CandleChart.jsx';
import { brl, pct, tone, num } from '../services/format.js';

const iso = (d) => d.toISOString().slice(0, 10);

export default function Backtest() {
  const [source, setSource] = useState('broker');
  const [p, setP] = useState({
    symbol: 'BTC-BRL', timeframe: '15m', from: iso(new Date(Date.now() - 30 * 86400000)), to: iso(new Date()),
    capital: 20, feePercent: 0.7, slippagePercent: 0.05, stopLossPercent: 2, takeProfitPercent: 3,
  });
  const [params, setParams] = useState({ fastPeriod: 9, slowPeriod: 21, rsiPeriod: 14, rsiBuyMax: 70, rsiExit: 80, trendPeriod: 50 });
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [res, setRes] = useState(null);
  const history = useApi('/api/backtest/history', res);
  const set = (k, n = true) => (e) => setP({ ...p, [k]: n ? Number(e.target.value) : e.target.value });

  async function run() {
    setBusy(true); setError(''); setRes(null);
    try {
      const body = { ...p, strategy: 'ema_rsi', strategyParams: params };
      const r = source === 'broker' ? await api.post('/api/backtest', body) : await api.post('/api/backtest/csv', { ...body, csv });
      setRes(r);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const s = res?.summary;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Backtest</h1>
      <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn">
        <TriangleAlert size={16} className="mt-0.5 shrink-0" />
        Resultados históricos não garantem resultados futuros. A simulação usa execução na abertura do candle seguinte ao sinal, taxas e slippage — o mercado real pode ser pior.
      </div>
      <Card title="Parâmetros" action={<Segmented value={source} onChange={setSource} options={[{ value: 'broker', label: 'Mercado Bitcoin' }, { value: 'csv', label: 'CSV (ex.: ações B3)' }]} />}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {source === 'broker' ? (
            <>
              <Field label="Ativo"><input className={inputCls} value={p.symbol} onChange={(e) => setP({ ...p, symbol: e.target.value.toUpperCase() })} /></Field>
              <Field label="Timeframe"><Select value={p.timeframe} onChange={(v) => setP({ ...p, timeframe: v })} options={['15m', '1h', '3h', '1d'].map((v) => ({ value: v, label: v }))} /></Field>
              <Field label="De"><input type="date" className={inputCls} value={p.from} onChange={set('from', false)} /></Field>
              <Field label="Até"><input type="date" className={inputCls} value={p.to} onChange={set('to', false)} /></Field>
            </>
          ) : (
            <div className="col-span-2 sm:col-span-3 lg:col-span-4">
              <Field label="Arquivo CSV (colunas: date, open, high, low, close, volume)">
                <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-3 text-sm text-ink-2 hover:bg-surface-2">
                  <Upload size={16} />{csv ? `${csv.split('\n').length - 1} linhas carregadas` : 'Selecionar arquivo'}
                  <input type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
                </label>
              </Field>
            </div>
          )}
          <Field label="Capital inicial (R$)"><input type="number" min="1" step="1" className={inputCls} value={p.capital} onChange={set('capital')} /></Field>
          <Field label="Taxa por execução (%)"><input type="number" min="0" step="0.05" className={inputCls} value={p.feePercent} onChange={set('feePercent')} /></Field>
          <Field label="Slippage (%)"><input type="number" min="0" step="0.01" className={inputCls} value={p.slippagePercent} onChange={set('slippagePercent')} /></Field>
          <Field label="Stop loss (%)"><input type="number" min="0.1" step="0.1" className={inputCls} value={p.stopLossPercent} onChange={set('stopLossPercent')} /></Field>
          <Field label="Take profit (%)"><input type="number" min="0.1" step="0.1" className={inputCls} value={p.takeProfitPercent} onChange={set('takeProfitPercent')} /></Field>
          <Field label="Estratégia"><input className={inputCls} value="EMA Cross + RSI" disabled /></Field>
          {Object.keys(params).map((k) => (
            <Field key={k} label={k}><input type="number" min="0" className={inputCls} value={params[k]} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} /></Field>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" onClick={run} disabled={busy || (source === 'csv' && !csv)}><FlaskConical size={16} />{busy ? 'Executando… (baixando candles)' : 'Rodar backtest'}</Button>
        </div>
        <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>
      </Card>

      {s && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Capital inicial" value={brl(s.initialCapital)} />
            <Stat label="Capital final" value={brl(s.finalCapital)} />
            <Stat label="P/L" value={brl(s.profitLoss, { sign: true })} valueClass={tone(s.profitLoss)} />
            <Stat label="P/L %" value={pct(s.profitLossPercent, { sign: true })} valueClass={tone(s.profitLossPercent)} />
            <Stat label="Nº de trades" value={s.trades} hint={`win rate ${pct(s.winRate, { d: 1 })}`} />
            <Stat label="Wins / Losses" value={`${s.wins} / ${s.losses}`} />
            <Stat label="Taxas" value={brl(s.fees)} />
            <Stat label="Drawdown máximo" value={pct(s.maxDrawdownPercent)} valueClass="text-bad" />
            <Stat label="Maior ganho" value={brl(s.biggestWin, { sign: true })} valueClass={tone(s.biggestWin)} />
            <Stat label="Maior perda" value={brl(s.biggestLoss)} valueClass={tone(s.biggestLoss)} />
            <Stat label="Candles" value={s.candles} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Equity curve"><TimeSeriesChart data={res.equity} x="t" xIsUnix y="equity" /></Card>
            <Card title="P/L acumulado"><TimeSeriesChart data={res.equity} x="t" xIsUnix y="pnl" baseline={0} color="var(--color-series-3)" /></Card>
            <Card title="Drawdown" className="lg:col-span-2"><TimeSeriesChart data={res.equity} x="t" xIsUnix y="drawdown" kind="pct" color="var(--color-series-2)" height={180} /></Card>
          </div>
          {res.candles && (
            <Card title="Preço e operações simuladas">
              <CandleChart candles={res.candles} markers={res.markers.map((m) => ({ ...m, purpose: m.reason }))} show={{ volume: true, indicators: false, markers: true, levels: false }} />
            </Card>
          )}
          <Card title="Trades simulados" pad={false}>
            <Table rows={res.trades.map((t, i) => ({ ...t, id: i }))} columns={[
              { key: 'openedAt', label: 'Entrada', render: (t) => new Date(t.openedAt * 1000).toLocaleString('pt-BR') },
              { key: 'side', label: 'Lado', render: () => sideBadge('BUY') },
              { key: 'entryPrice', label: 'Preço entrada', right: true, render: (t) => brl(t.entryPrice) },
              { key: 'exitPrice', label: 'Preço saída', right: true, render: (t) => brl(t.exitPrice) },
              { key: 'fees', label: 'Taxas', right: true, render: (t) => brl(t.fees) },
              { key: 'profitLoss', label: 'Resultado', right: true, render: (t) => <span className={tone(t.profitLoss)}>{brl(t.profitLoss, { sign: true })} ({pct(t.profitLossPercent, { sign: true })})</span> },
              { key: 'reason', label: 'Saída', render: (t) => <span className="text-xs text-ink-2">{t.reason}</span> },
            ]} />
          </Card>
        </>
      )}

      <Card title="Backtests anteriores" pad={false}>
        <Table rows={history.data?.rows} empty="Nenhum backtest ainda." columns={[
          { key: 'created_at', label: 'Data', render: (b) => new Date(b.created_at).toLocaleString('pt-BR') },
          { key: 'src', label: 'Fonte', render: (b) => (b.params.source === 'csv' ? 'CSV' : `${b.params.symbol} ${b.params.timeframe}`) },
          { key: 'per', label: 'Período', render: (b) => (b.params.from ? `${b.params.from} → ${b.params.to}` : '—') },
          { key: 'pl', label: 'P/L %', right: true, render: (b) => <span className={tone(b.summary.profitLossPercent)}>{pct(b.summary.profitLossPercent, { sign: true })}</span> },
          { key: 'tr', label: 'Trades', right: true, render: (b) => b.summary.trades },
          { key: 'fee', label: 'Taxas', right: true, render: (b) => brl(b.summary.fees) },
          { key: 'dd', label: 'DD máx.', right: true, render: (b) => pct(b.summary.maxDrawdownPercent) },
          { key: 'params', label: 'SL/TP', render: (b) => `${num(b.params.stopLossPercent, 1)}% / ${num(b.params.takeProfitPercent, 1)}%` },
        ]} />
      </Card>
    </div>
  );
}
