import { useState } from 'react';
import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { qs } from '../services/api.js';
import { Card, Table, Pagination, Badge, sideBadge, ORDER_TONE, Select, ErrorBox } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { brl, qty, dateTime } from '../services/format.js';

const STATUS = ['', 'OPEN', 'FILLED', 'PARTIAL', 'CANCELED', 'REJECTED', 'UNKNOWN', 'PENDING_SUBMIT'];

export default function Orders() {
  const { account, tick } = useBot();
  const [status, setStatus] = useState('');
  const [side, setSide] = useState('');
  const [page, setPage] = useState(1);
  const { data, error } = useApi(`/api/orders${qs({ account, page, pageSize: 25, status, side })}`, tick, { minIntervalMs: 4000 });

  const columns = [
    { key: 'id', label: 'ID' },
    { key: 'symbol', label: 'Ativo' },
    { key: 'side', label: 'Lado', render: (r) => sideBadge(r.side) },
    { key: 'price', label: 'Preço', right: true, render: (r) => brl(r.avg_fill_price ?? r.price) },
    { key: 'quantity', label: 'Quantidade', right: true, render: (r) => (r.filled_quantity ? qty(r.filled_quantity) : r.cost ? `${brl(r.cost)} (valor)` : qty(r.quantity)) },
    { key: 'status', label: 'Status', render: (r) => <Badge tone={ORDER_TONE[r.status]}>{r.status}</Badge> },
    { key: 'purpose', label: 'Motivo', render: (r) => <span className="text-xs text-ink-2">{r.purpose}</span> },
    { key: 'created_at', label: 'Criada em', render: (r) => dateTime(r.created_at) },
    { key: 'updated_at', label: 'Atualizada em', render: (r) => dateTime(r.updated_at) },
    { key: 'broker_order_id', label: 'Broker ID', render: (r) => <span className="font-mono text-xs text-ink-2" title={r.client_order_id}>{r.broker_order_id || '—'}</span> },
    { key: 'error', label: 'Erro', render: (r) => (r.error ? <span className="text-xs text-bad" title={r.error}>{r.error.slice(0, 40)}</span> : '') },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Ordens</h1>
        <ExportButton type="orders" account={account} label="Ordens CSV" />
      </div>
      <Card>
        <div className="grid grid-cols-2 gap-2 sm:w-96">
          <Select value={status} onChange={(v) => { setStatus(v); setPage(1); }} options={STATUS.map((s) => ({ value: s, label: s || 'Todos status' }))} />
          <Select value={side} onChange={(v) => { setSide(v); setPage(1); }} options={[{ value: '', label: 'BUY e SELL' }, { value: 'BUY', label: 'BUY' }, { value: 'SELL', label: 'SELL' }]} />
        </div>
      </Card>
      <ErrorBox>{error}</ErrorBox>
      <Card pad={false}>
        <Table columns={columns} rows={data?.rows} empty="Nenhuma ordem." />
        <Pagination page={page} pageSize={25} total={data?.total} onPage={setPage} />
      </Card>
      <p className="text-xs text-ink-3">UNKNOWN = resposta da corretora não confirmada (timeout/queda). O bot não opera até sincronizar e descobrir o estado real.</p>
    </div>
  );
}
