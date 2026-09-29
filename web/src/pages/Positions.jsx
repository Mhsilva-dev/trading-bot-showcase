import { useState } from 'react';
import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { Card, Table, Badge, Segmented } from '../components/ui.jsx';
import { brl, qty, pct, tone, dateTime } from '../services/format.js';

export default function Positions() {
  const { account, tick } = useBot();
  const [hist, setHist] = useState('0');
  const { data } = useApi(`/api/positions?account=${account}&history=${hist}`, tick, { minIntervalMs: 4000 });
  const columns = [
    { key: 'symbol', label: 'Ativo' },
    { key: 'quantity', label: 'Quantidade', right: true, render: (r) => qty(r.quantity) },
    { key: 'average_price', label: 'Preço médio', right: true, render: (r) => brl(r.average_price) },
    { key: 'current_price', label: 'Preço atual', right: true, render: (r) => brl(r.current_price) },
    { key: 'unrealized_profit', label: 'P/L aberto', right: true, render: (r) => (r.status === 'OPEN' ? <span className={tone(r.unrealized_profit)}>{brl(r.unrealized_profit, { sign: true })}</span> : '—') },
    { key: 'pct', label: 'P/L %', right: true, render: (r) => (r.status === 'OPEN' ? <span className={tone(r.unrealized_percent)}>{pct(r.unrealized_percent, { sign: true })}</span> : '—') },
    { key: 'stop_price', label: 'Stop', right: true, render: (r) => <span className="text-bad">{brl(r.stop_price)}</span> },
    { key: 'take_profit_price', label: 'Alvo', right: true, render: (r) => <span className="text-good">{brl(r.take_profit_price)}</span> },
    { key: 'status', label: 'Status', render: (r) => <Badge tone={r.status === 'OPEN' ? 'info' : 'muted'}>{r.status}</Badge> },
    { key: 'opened_at', label: 'Aberta em', render: (r) => dateTime(r.opened_at) },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Posições</h1>
        <Segmented value={hist} onChange={setHist} options={[{ value: '0', label: 'Abertas' }, { value: '1', label: 'Histórico' }]} />
      </div>
      <Card pad={false}><Table columns={columns} rows={data?.rows} empty="Nenhuma posição aberta." /></Card>
    </div>
  );
}
