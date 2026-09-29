import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { Card, Badge } from '../components/ui.jsx';
import { brl, qty, pct, tone, dateTime } from '../services/format.js';

// Ações/ativos comprados em todas as contas, com preço atualizado.
const ACCOUNTS = [
  { id: 'xp', label: 'XP (MT5)' },
  { id: 'live', label: 'Mercado Bitcoin' },
  { id: 'paper', label: 'Paper' },
];

function StockCard({ p, accountLabel }) {
  const paid = p.cost_basis || p.quantity * p.average_price;
  const now = p.quantity * p.current_price;
  const change = p.average_price ? ((p.current_price - p.average_price) / p.average_price) * 100 : 0;
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">{p.symbol}</div>
          <div className="text-xs text-ink-3">{accountLabel} · {qty(p.quantity)} un. · desde {dateTime(p.opened_at)}</div>
        </div>
        <Badge tone="info">aberta</Badge>
      </div>
      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-ink-3">Preço agora</div>
          <div className="tabular text-3xl font-semibold">{brl(p.current_price)}</div>
          <div className={`tabular text-sm ${tone(change)}`}>{pct(change, { sign: true })} desde a compra</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-ink-3">Resultado</div>
          <div className={`tabular text-xl font-semibold ${tone(p.unrealized_profit)}`}>{brl(p.unrealized_profit, { sign: true })}</div>
          <div className={`tabular text-sm ${tone(p.unrealized_percent)}`}>{pct(p.unrealized_percent, { sign: true })} com taxas</div>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 text-sm sm:grid-cols-4">
        <div><dt className="text-xs text-ink-3">Preço pago</dt><dd className="tabular">{brl(p.average_price)}</dd></div>
        <div><dt className="text-xs text-ink-3">Total pago</dt><dd className="tabular">{brl(paid)}</dd></div>
        <div><dt className="text-xs text-ink-3">Vale agora</dt><dd className="tabular">{brl(now)}</dd></div>
        <div><dt className="text-xs text-ink-3">Stop / Alvo</dt><dd className="tabular"><span className="text-bad">{brl(p.stop_price)}</span> / <span className="text-good">{brl(p.take_profit_price)}</span></dd></div>
      </dl>
    </Card>
  );
}

function AccountStocks({ id, label, tick }) {
  const { data } = useApi(`/api/positions?account=${id}&history=0`, tick, { minIntervalMs: 2000 });
  return (data?.rows || []).map((p) => <StockCard key={`${id}-${p.id}`} p={p} accountLabel={label} />);
}

export default function MyStocks() {
  const { tick } = useBot();
  const lists = ACCOUNTS.map((a) => <AccountStocks key={a.id} {...a} tick={tick} />);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Minhas ações</h1>
        <p className="text-xs text-ink-3">O que está comprado agora em cada conta, com o preço atualizando sozinho.</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">{lists}</div>
    </div>
  );
}
