import { useState } from 'react';
import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { qs } from '../services/api.js';
import { Card, Table, Pagination, Badge, sideBadge, ORDER_TONE, Select, inputCls, ErrorBox } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { brl, qty, dateTime, tone } from '../services/format.js';

export default function Operations() {
  const { account, tick } = useBot();
  const [f, setF] = useState({ from: '', to: '', symbol: '', side: '', result: '' });
  const [page, setPage] = useState(1);
  const set = (k) => (v) => { setF({ ...f, [k]: v }); setPage(1); };
  const { data, error } = useApi(`/api/executions${qs({ account, page, pageSize: 25, ...f })}`, tick, { minIntervalMs: 5000 });

  const columns = [
    { key: 'date', label: 'Data', render: (r) => dateTime(r.date) },
    { key: 'symbol', label: 'Ativo' },
    { key: 'side', label: 'Tipo', render: (r) => sideBadge(r.side) },
    { key: 'price', label: 'Preço', right: true, render: (r) => brl(r.price) },
    { key: 'quantity', label: 'Quantidade', right: true, render: (r) => qty(r.quantity) },
    { key: 'fees', label: 'Taxa', right: true, render: (r) => brl(r.fees) },
    { key: 'result', label: 'Resultado', right: true, render: (r) => (r.side === 'SELL' && r.result !== null ? <span className={tone(r.result)}>{brl(r.result, { sign: true })}</span> : '—') },
    { key: 'status', label: 'Status', render: (r) => <Badge tone={ORDER_TONE[r.status]}>{r.status}</Badge> },
    { key: 'purpose', label: 'Motivo', render: (r) => <span className="text-xs text-ink-2">{r.purpose}</span> },
    { key: 'strategy', label: 'Estratégia', render: (r) => r.strategy || '—' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Operações</h1>
        <div className="flex gap-2"><ExportButton type="trades" account={account} label="Trades CSV" /><ExportButton type="metrics" account={account} label="Métricas CSV" /></div>
      </div>
      <Card>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <input type="date" className={inputCls} value={f.from} onChange={(e) => set('from')(e.target.value)} aria-label="Data inicial" />
          <input type="date" className={inputCls} value={f.to} onChange={(e) => set('to')(e.target.value)} aria-label="Data final" />
          <input className={inputCls} placeholder="Ativo (ex.: BTC-BRL)" value={f.symbol} onChange={(e) => set('symbol')(e.target.value.toUpperCase())} />
          <Select value={f.side} onChange={set('side')} options={[{ value: '', label: 'BUY e SELL' }, { value: 'BUY', label: 'BUY' }, { value: 'SELL', label: 'SELL' }]} />
          <Select value={f.result} onChange={set('result')} options={[{ value: '', label: 'Todos resultados' }, { value: 'WIN', label: 'WIN' }, { value: 'LOSS', label: 'LOSS' }]} />
        </div>
      </Card>
      <ErrorBox>{error}</ErrorBox>
      <Card pad={false}>
        <Table columns={columns} rows={data?.rows} empty="Nenhuma operação com esses filtros." />
        <Pagination page={page} pageSize={25} total={data?.total} onPage={setPage} />
      </Card>
    </div>
  );
}
