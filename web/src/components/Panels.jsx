// Blocos compartilhados entre telas (patrimônio, P/L, preço, posição, métricas).
import { useMemo, useState } from 'react';
import { Wallet, TrendingUp, Percent, TrendingDown, Receipt, Activity, ArrowUpRight, ArrowDownRight, Trophy, CircleX, Target, Landmark } from 'lucide-react';
import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { qs } from '../services/api.js';
import { Card, Segmented, Stat, Empty, sideBadge, inputCls } from './ui.jsx';
import { TimeSeriesChart } from '../charts/TimeSeriesChart.jsx';
import { CandleChart } from '../charts/CandleChart.jsx';
import { brl, pct, qty, tone, dateTime, num } from '../services/format.js';

export function KpiGrid() {
  const { account, status, tick } = useBot();
  const { data: m } = useApi(`/api/metrics?account=${account}`, tick, { minIntervalMs: 5000 });
  const s = status || {};
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      <Stat icon={Wallet} label="Saldo" value={brl(s.balance)} hint="disponível em reais" />
      <Stat icon={Landmark} label="Patrimônio" value={brl(s.equity)} hint="saldo + posição a mercado" />
      <Stat icon={TrendingUp} label="Lucro hoje" value={brl(s.dailyPnL, { sign: true })} valueClass={tone(s.dailyPnL)} />
      <Stat icon={Activity} label="Lucro total" value={brl(s.totalPnL, { sign: true })} valueClass={tone(s.totalPnL)} hint="realizado + aberto" />
      <Stat icon={Percent} label="P/L %" value={pct(m?.totalPnLPercent, { sign: true })} valueClass={tone(m?.totalPnLPercent)} hint="desde o 1º registro" />
      <Stat icon={TrendingDown} label="Drawdown máx." value={pct(m?.maxDrawdown)} valueClass={m?.maxDrawdown > 0 ? 'text-bad' : 'text-ink'} />
      <Stat icon={Receipt} label="Taxas pagas" value={brl(m?.fees)} />
      <Stat icon={Target} label="Operações hoje" value={m?.tradesToday ?? '—'} />
      <Stat icon={ArrowUpRight} label="Compras hoje" value={m?.buysToday ?? '—'} />
      <Stat icon={ArrowDownRight} label="Vendas hoje" value={m?.sellsToday ?? '—'} />
      <Stat icon={Trophy} label="Wins" value={m?.wins ?? '—'} valueClass="text-good" />
      <Stat icon={CircleX} label="Losses" value={m?.losses ?? '—'} valueClass={m?.losses ? 'text-bad' : 'text-ink'} hint={m ? `win rate ${pct(m.winRate, { d: 1 })}` : null} />
    </div>
  );
}

export function EquityPanel() {
  const { account, tick } = useBot();
  const [range, setRange] = useState('1D');
  const { data } = useApi(`/api/equity?account=${account}&range=${range}`, tick, { minIntervalMs: 15000 });
  return (
    <Card title="Patrimônio × tempo" action={<Segmented value={range} onChange={setRange} options={['1H', '6H', '1D', '7D', '30D', 'ALL'].map((v) => ({ value: v, label: v === 'ALL' ? 'Tudo' : v }))} />}>
      <TimeSeriesChart data={data?.rows} y="equity" />
    </Card>
  );
}

function periodRange(p, custom) {
  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  if (p === 'today') return { from: iso(now) };
  if (p === 'week') return { from: iso(new Date(now - 7 * 86400000)) };
  if (p === 'month') return { from: iso(new Date(now - 30 * 86400000)) };
  if (p === 'custom') return custom;
  return {};
}

export function PnlPanel() {
  const { account, tick } = useBot();
  const [period, setPeriod] = useState('month');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const r = periodRange(period, custom);
  const { data } = useApi(`/api/pnl${qs({ account, ...r })}`, tick, { minIntervalMs: 15000 });
  return (
    <Card title="P/L acumulado (realizado)" action={<Segmented value={period} onChange={setPeriod} options={[{ value: 'today', label: 'Hoje' }, { value: 'week', label: 'Semana' }, { value: 'month', label: 'Mês' }, { value: 'all', label: 'Tudo' }, { value: 'custom', label: 'Período' }]} />}>
      {period === 'custom' && (
        <div className="mb-3 flex flex-wrap gap-2">
          <input type="date" className={`${inputCls} w-auto`} value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="De" />
          <input type="date" className={`${inputCls} w-auto`} value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="Até" />
        </div>
      )}
      <TimeSeriesChart data={data?.rows} y="cumulative" baseline={0} color="var(--color-series-3)" />
    </Card>
  );
}

export function PricePanel({ height = 380 }) {
  const { account, tick } = useBot();
  const { data } = useApi(`/api/candles?account=${account}&limit=300`, tick, { minIntervalMs: 20000 });
  const [show, setShow] = useState({ volume: true, indicators: true, markers: true, levels: true });
  const toggles = [['indicators', 'Indicadores'], ['volume', 'Volume'], ['markers', 'Compras/vendas'], ['levels', 'Stop/Take']];
  const last = data?.candles?.at(-1);
  return (
    <Card title={data ? `${data.symbol} · ${data.timeframe}` : 'Preço'} action={last && <span className="tabular text-sm font-semibold">{brl(last.c)}</span>}>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {toggles.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setShow({ ...show, [k]: !show[k] })}
            className={`rounded-md border px-2 py-1 text-xs ${show[k] ? 'border-series-1/50 bg-series-1/15 text-series-1' : 'border-border text-ink-3'}`}>{l}</button>
        ))}
      </div>
      {data?.candles?.length ? <CandleChart candles={data.candles} indicators={data.indicators} markers={data.markers} position={data.position} show={show} height={height} /> : <Empty>Sem candles ainda — o bot grava o histórico enquanto roda.</Empty>}
      {show.indicators && data?.candles?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-series-1" />EMA rápida</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-series-2" />EMA lenta</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-series-3" />EMA tendência</span>
        </div>
      )}
    </Card>
  );
}

export function PositionCard() {
  const { status } = useBot();
  const p = status?.position;
  const t = status?.ticker;
  const basis = useMemo(() => (p ? p.quantity * p.average_price : 0), [p]);
  return (
    <Card title="Posição atual">
      {!p ? <Empty>Sem posição aberta.</Empty> : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div><dt className="text-xs text-ink-3">Ativo</dt><dd className="font-medium">{p.symbol}</dd></div>
          <div><dt className="text-xs text-ink-3">Quantidade</dt><dd className="tabular">{qty(p.quantity)}</dd></div>
          <div><dt className="text-xs text-ink-3">Preço médio</dt><dd className="tabular">{brl(p.average_price)}</dd></div>
          <div><dt className="text-xs text-ink-3">Preço atual (bid)</dt><dd className="tabular">{brl(t?.bid ?? p.current_price)}</dd></div>
          <div><dt className="text-xs text-ink-3">P/L aberto</dt><dd className={`tabular font-semibold ${tone(p.unrealized_profit)}`}>{brl(p.unrealized_profit, { sign: true })} <span className="text-xs font-normal">({pct(basis ? (p.unrealized_profit / basis) * 100 : 0, { sign: true })})</span></dd></div>
          <div><dt className="text-xs text-ink-3">Aberta em</dt><dd className="tabular">{dateTime(p.opened_at)}</dd></div>
          <div><dt className="text-xs text-ink-3">Stop-loss</dt><dd className="tabular text-bad">{brl(p.stop_price)}</dd></div>
          <div><dt className="text-xs text-ink-3">Take-profit</dt><dd className="tabular text-good">{brl(p.take_profit_price)}</dd></div>
        </dl>
      )}
    </Card>
  );
}

export function RecentTrades({ limit = 8 }) {
  const { account, tick, go } = useBot();
  const { data } = useApi(`/api/executions?account=${account}&pageSize=${limit}`, tick, { minIntervalMs: 4000 });
  return (
    <Card title="Últimas operações" action={<button type="button" className="text-xs text-series-1" onClick={() => go('operations')}>ver todas</button>} pad={false}>
      {!data?.rows?.length ? <Empty>Nenhuma operação ainda.</Empty> : (
        <ul className="divide-y divide-border">
          {data.rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              {sideBadge(r.side)}
              <div className="min-w-0 flex-1">
                <div className="tabular">{qty(r.quantity)} @ {brl(r.price)}</div>
                <div className="text-xs text-ink-3">{dateTime(r.date)} · {r.purpose}</div>
              </div>
              {r.side === 'SELL' && r.result !== null && <span className={`tabular font-medium ${tone(r.result)}`}>{brl(r.result, { sign: true })}</span>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function SignalLine({ s }) {
  if (!s) return <span className="text-ink-3">—</span>;
  return <span className="inline-flex items-center gap-2">{sideBadge(s.signal)}<span className="text-ink-2">conf. {num(s.confidence, 2)}</span></span>;
}
