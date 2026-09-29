import { useBot } from '../context.js';
import { BotControls } from '../components/BotControls.jsx';
import { KpiGrid, EquityPanel, PnlPanel, PricePanel, PositionCard, RecentTrades, SignalLine } from '../components/Panels.jsx';
import { Card, Badge, sideBadge } from '../components/ui.jsx';
import { time, ago } from '../services/format.js';

function StatusCard() {
  const { status: s } = useBot();
  if (!s) return <Card title="Status do bot"><p className="text-sm text-ink-3">Aguardando dados…</p></Card>;
  const riskTone = s.riskStatus === 'NORMAL' ? 'good' : s.riskStatus === 'HALTED' ? 'bad' : 'warn';
  const rows = [
    ['Modo', <Badge tone={s.mode === 'LIVE' ? 'bad' : 'info'}>{s.mode}</Badge>],
    ['Estratégia', s.strategyLabel || '—'],
    ['Ativo', s.symbol ? `${s.symbol} · ${s.timeframe}` : '—'],
    ['Corretora', <span>{s.broker || '—'} <span className={s.brokerStatus === 'CONNECTED' ? 'text-good' : 'text-bad'}>({s.brokerStatus === 'CONNECTED' ? 'conectada' : 'desconectada'})</span></span>],
    ['Risco', <Badge tone={riskTone}>{s.riskStatus === 'NORMAL' ? 'NORMAL' : s.riskStatus === 'HALTED' ? 'TRADING HALTED' : 'TRADING BLOCKED'}</Badge>],
    ['Última análise', s.lastAnalysisAt ? `${time(s.lastAnalysisAt)} (${ago(s.lastAnalysisAt)})` : '—'],
    ['Último sinal', <SignalLine s={s.lastSignal} />],
    ['Última operação', s.lastTrade ? <span className="inline-flex items-center gap-2">{sideBadge(s.lastTrade.side)}<span className="text-ink-2">{time(s.lastTrade.date)}</span></span> : '—'],
    ['Próxima verificação', s.nextCheckAt ? time(s.nextCheckAt) : '—'],
    ['Heartbeat', s.heartbeatAt ? ago(s.heartbeatAt) : '—'],
  ];
  return (
    <Card title="Status do bot">
      <dl className="grid grid-cols-1 gap-2.5 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3 border-b border-border/50 pb-2 sm:block sm:border-0 sm:pb-0">
            <dt className="text-xs text-ink-3">{k}</dt><dd className="text-right sm:mt-0.5 sm:text-left">{v}</dd>
          </div>
        ))}
      </dl>
      {s.riskReason && s.riskStatus !== 'NORMAL' && <p className="mt-3 rounded-lg bg-warn/10 p-2 text-xs text-warn">Motivo: {s.riskReason}</p>}
      {s.lastSignal?.reason && <p className="mt-2 text-xs text-ink-3">Sinal: {s.lastSignal.reason}</p>}
    </Card>
  );
}

export default function Overview() {
  const { status } = useBot();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Visão geral</h1>
          <p className="text-xs text-ink-3">{status?.account?.name || ''} — métricas descritivas, não são promessa de desempenho.</p>
        </div>
        <BotControls />
      </div>
      <KpiGrid />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <PricePanel />
          <EquityPanel />
          <PnlPanel />
        </div>
        <div className="min-w-0 space-y-4">
          <StatusCard />
          <PositionCard />
          <RecentTrades />
        </div>
      </div>
    </div>
  );
}
