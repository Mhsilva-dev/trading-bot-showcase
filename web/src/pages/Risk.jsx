import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { Card, Stat, Empty } from '../components/ui.jsx';
import { brl, pct, tone } from '../services/format.js';

function Meter({ label, value, max, fmt = (v) => v }) {
  const p = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const color = p >= 100 ? 'bg-bad' : p >= 70 ? 'bg-warn' : 'bg-good';
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs"><span className="text-ink-2">{label}</span><span className="tabular text-ink">{fmt(value)} / {fmt(max)}</span></div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2"><div className={`h-full rounded-full ${color}`} style={{ width: `${p}%` }} /></div>
    </div>
  );
}

export default function Risk() {
  const { account, tick } = useBot();
  const { data: r } = useApi(`/api/risk?account=${account}`, tick, { minIntervalMs: 3000 });
  if (!r) return <Empty>Carregando…</Empty>;
  const normal = r.status === 'NORMAL';
  const label = normal ? 'NORMAL' : r.status === 'HALTED' ? 'TRADING HALTED' : 'TRADING BLOCKED';
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Risco</h1>
      <Card>
        <div className="flex items-start gap-3">
          <div className={`rounded-xl p-3 ${normal ? 'bg-good/15 text-good' : 'bg-bad/15 text-bad'}`}>{normal ? <ShieldCheck size={28} /> : <ShieldAlert size={28} />}</div>
          <div className="min-w-0">
            <div className="text-xs text-ink-3">Risk Status</div>
            <div className={`text-2xl font-bold ${normal ? 'text-good' : 'text-bad'}`}>{normal ? '🟢' : '🔴'} {label}</div>
            {!normal && r.reasons.length > 0 && (
              <div className="mt-2 text-sm"><span className="text-ink-3">Motivo:</span>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            )}
            {!r.tradingEnabled && <p className="mt-2 text-xs text-warn">Kill switch: TRADING_ENABLED=false no .env — nenhuma ordem é enviada.</p>}
          </div>
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Capital disponível" value={brl(r.capitalAvailable)} />
        <Stat label="Capital utilizado" value={brl(r.capitalUsed)} />
        <Stat label="Exposição" value={pct(r.exposurePercent)} hint={`máx. ${pct(r.maxPositionPercent, { d: 0 })}`} />
        <Stat label="Perda/ganho hoje" value={brl(r.dailyPnL, { sign: true })} valueClass={tone(r.dailyPnL)} hint={`limite diário ${brl(-r.dailyLossLimit)}`} />
        <Stat label="Drawdown hoje" value={pct(r.drawdownToday)} />
        <Stat label="Drawdown máximo" value={pct(r.maxDrawdown)} />
        <Stat label="Operações restantes" value={r.tradesRemaining ?? '∞'} hint={`${r.tradesToday} de ${r.maxDailyTrades || '∞'} hoje`} />
        <Stat label="Máx. por operação" value={brl(r.maxOrderValue)} />
      </div>
      <Card title="Limites">
        <div className="space-y-4">
          <Meter label="Limite de perda diária usado" value={Math.max(0, -(r.dailyPnL || 0))} max={r.dailyLossLimit} fmt={(v) => brl(v)} />
          <Meter label="Operações no dia" value={r.tradesToday} max={r.maxDailyTrades} />
          <Meter label="Exposição" value={r.exposurePercent} max={r.maxPositionPercent} fmt={(v) => pct(v, { d: 0 })} />
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg bg-surface-2 p-2"><div className="text-ink-3">Stop-loss</div><div className="tabular text-sm text-bad">{pct(r.stopLossPercent)}</div></div>
            <div className="rounded-lg bg-surface-2 p-2"><div className="text-ink-3">Take-profit</div><div className="tabular text-sm text-good">{pct(r.takeProfitPercent)}</div></div>
            <div className="rounded-lg bg-surface-2 p-2"><div className="text-ink-3">Spread máx.</div><div className="tabular text-sm">{pct(r.maxSpreadPercent)}</div></div>
          </div>
        </div>
      </Card>
    </div>
  );
}
