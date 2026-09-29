import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useBot } from '../context.js';
import { BotControls, sendCommand } from '../components/BotControls.jsx';
import { EquityPanel, PositionCard, RecentTrades } from '../components/Panels.jsx';
import { Card, Stat, Button, ConfirmDialog, Field, inputCls, toast, Badge } from '../components/ui.jsx';
import { brl, tone } from '../services/format.js';
import { useApi } from '../hooks/useApi.js';

export default function Paper() {
  const { accounts, account, setAccount, tick } = useBot();
  const s = accounts.find((a) => a.account?.id === 'paper');
  const [open, setOpen] = useState(false);
  const [capital, setCapital] = useState(20);
  const orders = useApi('/api/orders?account=paper&pageSize=5', tick);

  if (account !== 'paper') {
    return (
      <Card title="Paper Trading">
        <p className="text-sm text-ink-2">Você está vendo a conta LIVE. O paper trading roda em paralelo, com saldo virtual separado.</p>
        <Button className="mt-3" variant="primary" onClick={() => setAccount('paper')}>Ver conta PAPER</Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Paper Trading <Badge tone="info">SIMULAÇÃO</Badge></h1>
          <p className="text-xs text-ink-3">Preços reais do Mercado Bitcoin, execução simulada com taxa e slippage configuráveis. Roda junto com a conta LIVE.</p>
        </div>
        <BotControls />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Saldo virtual" value={brl(s?.balance)} />
        <Stat label="Patrimônio" value={brl(s?.equity)} />
        <Stat label="P/L total" value={brl(s?.totalPnL, { sign: true })} valueClass={tone(s?.totalPnL)} />
        <Stat label="P/L hoje" value={brl(s?.dailyPnL, { sign: true })} valueClass={tone(s?.dailyPnL)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2"><EquityPanel /></div>
        <PositionCard />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <RecentTrades />
        <Card title="Ordens recentes">
          <ul className="space-y-2 text-sm">
            {(orders.data?.rows || []).map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2"><span>{o.side} · {o.purpose}</span><Badge tone={o.status === 'FILLED' ? 'good' : o.status === 'REJECTED' ? 'bad' : 'warn'}>{o.status}</Badge></li>
            ))}
            {!orders.data?.rows?.length && <li className="text-ink-3">Nenhuma ordem.</li>}
          </ul>
        </Card>
      </div>
      <Card title="Resetar ambiente de simulação">
        <p className="mb-3 text-sm text-ink-2">Apaga ordens, trades, posições, sinais e métricas da conta PAPER e volta ao capital escolhido. Exige o bot parado.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Capital inicial (R$)"><input type="number" min="1" className={`${inputCls} w-40`} value={capital} onChange={(e) => setCapital(Number(e.target.value))} /></Field>
          <Button variant="warn" onClick={() => setOpen(true)}><RotateCcw size={16} />Resetar paper</Button>
        </div>
      </Card>
      <ConfirmDialog open={open} danger title="Resetar paper trading?" confirmLabel="Resetar"
        message={`Todo o histórico da conta PAPER será apagado e o saldo volta para ${brl(capital)}. Isso não afeta a conta LIVE.`}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          try { await sendCommand('paper', 'reset_paper', { confirm: true, capital }); toast('Paper trading resetado', 'good'); } catch (e) { toast(e.message, 'bad'); }
          setOpen(false);
        }} />
    </div>
  );
}
