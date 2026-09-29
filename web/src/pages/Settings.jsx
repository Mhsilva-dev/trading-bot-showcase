import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { api } from '../services/api.js';
import { Card, Field, Button, ConfirmDialog, Select, inputCls, toast, Badge, ErrorBox } from '../components/ui.jsx';

const RISK_FIELDS = [
  ['stopLossPercent', 'Stop loss (%)', 0.1],
  ['takeProfitPercent', 'Take profit (%)', 0.1],
  ['maxDailyLoss', 'Limite de perda diária (R$)', 0.1],
  ['maxPositionPercent', 'Exposição máxima (% do patrimônio)', 1],
  ['maxOrderValue', 'Máximo por operação (R$)', 1],
  ['maxDailyTrades', 'Máximo de operações por dia', 1],
  ['maxSpreadPercent', 'Spread máximo (%)', 0.01],
  ['min24hVolume', 'Volume mínimo 24h (R$)', 1000],
];

export default function SettingsPage() {
  const { account } = useBot();
  const { data, reload, error } = useApi(`/api/settings?account=${account}`);
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => { if (data) setForm(structuredClone(data.values)); }, [data]);
  if (!data || !form) return <div className="text-sm text-ink-3">{error || 'Carregando…'}</div>;

  const sys = data.system;
  const strat = data.strategies.find((s) => s.name === form.strategy);
  const changed = Object.keys(form).filter((k) => JSON.stringify(form[k]) !== JSON.stringify(data.values[k]));
  const setNum = (k) => (e) => setForm({ ...form, [k]: e.target.value === '' ? '' : Number(e.target.value) });

  async function save() {
    setSaveError('');
    const values = Object.fromEntries(changed.map((k) => [k, form[k]]));
    try {
      await api.put('/api/settings', { account, confirm: true, values });
      toast('Configurações salvas e enviadas ao bot', 'good');
      reload();
    } catch (e) { setSaveError(e.message); }
    setConfirm(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Configurações <Badge tone={account === 'live' ? 'bad' : 'info'}>{account.toUpperCase()}</Badge></h1>
        <Button variant="primary" disabled={!changed.length} onClick={() => setConfirm(true)}><Save size={16} />Salvar {changed.length ? `(${changed.length})` : ''}</Button>
      </div>
      <ErrorBox>{saveError}</ErrorBox>

      <Card title="Trading">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Modo" hint="Definido no .env (TRADING_MODE / LIVE_TRADING_CONFIRM) — não é alterável pelo painel.">
            <input className={inputCls} disabled value={`${sys.tradingMode.toUpperCase()}${sys.liveBlockReason ? ' (live bloqueado)' : ''}`} />
          </Field>
          <Field label="Ativo" hint={account === 'xp' ? 'Código B3; final F = fracionário (ex.: PETR4F, VALE3F, BBDC4F)' : 'Formato BASE-QUOTE, ex.: BTC-BRL, ETH-BRL'}>
            <input className={inputCls} value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Timeframe"><Select value={form.timeframe} onChange={(v) => setForm({ ...form, timeframe: v })} options={(account === 'xp' ? ['15m'] : data.timeframes).map((t) => ({ value: t, label: t }))} /></Field>
          <Field label="Estratégia"><Select value={form.strategy} onChange={(v) => setForm({ ...form, strategy: v })} options={data.strategies.map((s) => ({ value: s.name, label: s.label }))} /></Field>
        </div>
        {!sys.tradingEnabled && <p className="mt-3 text-xs text-warn">TRADING_ENABLED=false no .env: o kill switch global está ativo e nenhuma ordem é enviada.</p>}
      </Card>

      <Card title="Parâmetros da estratégia">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(strat.defaults).map(([k]) => (
            <Field key={k} label={k} hint={strat.docs?.[k]}>
              <input type="number" min="0" className={inputCls} value={form.strategyParams[k]} onChange={(e) => setForm({ ...form, strategyParams: { ...form.strategyParams, [k]: Number(e.target.value) } })} />
            </Field>
          ))}
        </div>
      </Card>

      <Card title="Risco">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {RISK_FIELDS.map(([k, l, step]) => (
            <Field key={k} label={l}><input type="number" min="0" step={step} className={inputCls} value={form[k]} onChange={setNum(k)} /></Field>
          ))}
          <Field label="Ao parar o bot" hint="Continuar gerenciando stop/take da posição aberta?">
            <Select value={String(form.stopManageExits)} onChange={(v) => setForm({ ...form, stopManageExits: v === 'true' })} options={[{ value: 'true', label: 'Sim, gerenciar saídas' }, { value: 'false', label: 'Não enviar nenhuma ordem' }]} />
          </Field>
        </div>
      </Card>

      <Card title="Sistema">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {[
            ['Intervalo de verificação', `${sys.priceCheckIntervalSec}s`],
            ['Reconciliação', `a cada ${sys.reconcileIntervalSec}s`],
            ['Timezone', sys.timezone],
            ['Corretora', sys.broker],
            ['Taxa simulada (paper)', `${sys.paperFeePercent}%`],
            ['Slippage simulado', `${sys.paperSlippagePercent}%`],
            ['Capital inicial paper', `R$ ${sys.initialCapital}`],
            ['Logs', 'banco (bot_events) + PM2'],
          ].map(([k, v]) => <div key={k}><dt className="text-xs text-ink-3">{k}</dt><dd>{v}</dd></div>)}
        </dl>
        <p className="mt-3 text-xs text-ink-3">Credenciais da corretora e segredos ficam apenas no .env do servidor e nunca são enviados ao navegador.</p>
      </Card>

      <ConfirmDialog open={confirm} title="Salvar alterações?" confirmLabel="Salvar" danger={account === 'live'}
        message={`Alterações na conta ${account.toUpperCase()}: ${changed.join(', ')}. O bot recarrega as configurações no próximo ciclo e a mudança fica registrada no log.`}
        onCancel={() => setConfirm(false)} onConfirm={save} />
    </div>
  );
}
