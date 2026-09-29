import { useState } from 'react';
import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { Card, Table, Segmented, sideBadge, Empty } from '../components/ui.jsx';
import { PricePanel } from '../components/Panels.jsx';
import { brl, num, dateTime } from '../services/format.js';

export default function Strategy() {
  const { account, tick } = useBot();
  const { data } = useApi(`/api/strategy?account=${account}`, tick, { minIntervalMs: 5000 });
  const [filter, setFilter] = useState('ALL');
  const signals = (data?.signals || []).filter((s) => filter === 'ALL' || s.signal === filter);
  const ls = data?.lastSignal;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Estratégia</h1>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Estratégia atual">
          {!data ? <Empty /> : (
            <div className="space-y-3 text-sm">
              <div><div className="text-xs text-ink-3">Nome</div><div className="font-medium">{data.label} <span className="text-ink-3">({data.name})</span></div></div>
              <div><div className="text-xs text-ink-3">Ativo / timeframe</div><div>{data.symbol} · {data.timeframe}</div></div>
              <div><div className="text-xs text-ink-3">Indicadores</div><div>EMA rápida, EMA lenta, EMA de tendência, RSI (Wilder)</div></div>
              <p className="rounded-lg bg-surface-2 p-2 text-xs text-ink-3">{data.note}</p>
            </div>
          )}
        </Card>
        <Card title="Parâmetros">
          {!data ? <Empty /> : (
            <dl className="space-y-2 text-sm">
              {Object.entries(data.params).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3 border-b border-border/50 pb-2">
                  <dt><div className="font-mono text-xs">{k}</div><div className="text-xs text-ink-3">{data.docs?.[k]}</div></dt>
                  <dd className="tabular font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </Card>
        <Card title="Último sinal">
          {!ls ? <Empty>Nenhum sinal ainda (o bot avalia a cada candle fechado).</Empty> : (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-3">{sideBadge(ls.signal)}<span className="tabular">{brl(ls.price)}</span><span className="text-ink-3">conf. {num(ls.confidence)}</span></div>
              <div><div className="text-xs text-ink-3">Motivo</div><div>{ls.reason}</div></div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.entries(ls.indicators || {}).map(([k, v]) => <div key={k} className="rounded-lg bg-surface-2 p-2"><div className="text-ink-3">{k}</div><div className="tabular text-sm text-ink">{v === null ? '—' : num(v, k === 'rsi' ? 1 : 2)}</div></div>)}
              </div>
              <div className="text-xs text-ink-3">{dateTime(ls.at)}</div>
            </div>
          )}
        </Card>
      </div>
      <PricePanel height={320} />
      <Card title="Sinais recentes" action={<Segmented value={filter} onChange={setFilter} options={['ALL', 'BUY', 'SELL', 'HOLD'].map((v) => ({ value: v, label: v === 'ALL' ? 'Todos' : v }))} />} pad={false}>
        <Table rows={signals} empty="Sem sinais." columns={[
          { key: 'created_at', label: 'Data', render: (r) => dateTime(r.created_at) },
          { key: 'signal', label: 'Sinal', render: (r) => sideBadge(r.signal) },
          { key: 'price', label: 'Preço', right: true, render: (r) => brl(r.price) },
          { key: 'confidence', label: 'Conf.', right: true, render: (r) => num(r.confidence) },
          { key: 'reason', label: 'Motivo', className: 'max-w-md whitespace-normal text-ink-2' },
        ]} />
      </Card>
    </div>
  );
}
