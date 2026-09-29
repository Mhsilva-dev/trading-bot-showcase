import { useState } from 'react';
import { Plug, ShieldCheck, Trash2, TriangleAlert, Lock } from 'lucide-react';
import { api } from '../services/api.js';
import { useApi } from '../hooks/useApi.js';
import { Card, Field, Button, Badge, ErrorBox, ConfirmDialog, Segmented, inputCls, toast } from '../components/ui.jsx';
import { dateTime } from '../services/format.js';

const BRIDGE = {
  NOT_CONFIGURED: ['muted', 'Não configurada'],
  WAITING: ['warn', 'Aguardando ponte MT5'],
  CONNECTED: ['good', 'Conectada'],
  OFF_HOURS: ['muted', 'Fora do horário do pregão'],
  ERROR: ['bad', 'Erro na conexão'],
};

function XpCard({ c, onChange }) {
  const [form, setForm] = useState({ environment: 'demo', server: '', login: '', password: '', currentPassword: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReal, setConfirmReal] = useState(false);
  const [del, setDel] = useState(false);
  const [delPw, setDelPw] = useState('');
  const [bTone, bLabel] = BRIDGE[c.bridge.status] || BRIDGE.ERROR;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save(real = false) {
    setBusy(true); setError('');
    try {
      await api.put('/api/connections/xp_mt5', { ...form, ...(real ? { confirmReal: true } : {}) });
      setForm({ ...form, password: '', currentPassword: '' });
      toast('Conta XP salva com segurança', 'good');
      onChange();
    } catch (e) {
      if (e.data?.needsConfirm) setConfirmReal(true); else setError(e.message);
    } finally { setBusy(false); }
  }

  return (
    <Card title={<span className="inline-flex items-center gap-2"><Plug size={16} />{c.label}</span>} action={<Badge tone={bTone}>{bLabel}</Badge>}>
      {c.configured && (
        <div className="mb-4 grid gap-3 rounded-lg border border-border bg-bg p-3 text-sm sm:grid-cols-4">
          <div><div className="text-xs text-ink-3">Ambiente</div><Badge tone={c.environment === 'real' ? 'bad' : 'info'}>{c.environment?.toUpperCase()}</Badge></div>
          <div><div className="text-xs text-ink-3">Servidor</div><div>{c.server}</div></div>
          <div><div className="text-xs text-ink-3">Login</div><div className="font-mono">{c.login}</div></div>
          <div><div className="text-xs text-ink-3">Atualizado</div><div>{dateTime(c.updatedAt)} · {c.updatedBy}</div></div>
          {c.bridge.message && <div className="text-xs text-ink-3 sm:col-span-4">{c.bridge.message}</div>}
        </div>
      )}

      <div className="mb-4 flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
        <TriangleAlert size={16} className="mt-0.5 shrink-0" />
        <div>
          Use os dados do <b>MetaTrader 5</b> que a XP envia ao contratar a plataforma (servidor, número da conta MT5 e senha do MT5).
          <b> Nunca</b> informe a senha do app/site da XP nem a sua assinatura eletrônica. Comece pela conta <b>DEMO</b>.
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ambiente">
          <Segmented size="md" value={form.environment} onChange={(v) => setForm({ ...form, environment: v })} options={[{ value: 'demo', label: 'DEMO (sem dinheiro)' }, { value: 'real', label: 'REAL' }]} />
        </Field>
        <Field label="Servidor MT5" hint="Exatamente como a XP informar (ex.: demo.mt5.xpi.com.br:443)">
          <input className={inputCls} value={form.server} onChange={set('server')} autoComplete="off" maxLength={64} />
        </Field>
        <Field label="Login (número da conta MT5)" hint="NÃO é o CPF — é o número que a XP gera para o MT5 Simulado">
          <input className={inputCls} value={form.login} onChange={(e) => setForm({ ...form, login: e.target.value.replace(/\D/g, '') })} inputMode="numeric" autoComplete="off" maxLength={20} />
        </Field>
        <Field label="Senha do MT5" hint={c.configured ? 'Para trocar qualquer dado, informe a senha de novo' : 'Fica cifrada no servidor; nunca volta para o navegador'}>
          <input className={inputCls} type="password" value={form.password} onChange={set('password')} autoComplete="new-password" maxLength={128} />
        </Field>
        <Field label="Sua senha do painel" hint="Confirmação de que é você fazendo a alteração">
          <input className={inputCls} type="password" value={form.currentPassword} onChange={set('currentPassword')} autoComplete="current-password" maxLength={256} />
        </Field>
      </div>
      <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || !form.server || !form.login || !form.password || !form.currentPassword} onClick={() => save(false)}>
          <Lock size={16} />{busy ? 'Salvando…' : c.configured ? 'Atualizar conta' : 'Conectar conta XP'}
        </Button>
        {c.configured && <Button variant="ghost" className="text-bad" onClick={() => setDel(true)}><Trash2 size={16} />Remover</Button>}
      </div>

      <ConfirmDialog open={confirmReal} danger title="Cadastrar conta REAL?" confirmLabel="Sim, é conta real"
        message="Essa conta movimenta dinheiro de verdade. O bot só enviará ordens nela depois das fases de teste e com o modo live liberado no servidor."
        onCancel={() => setConfirmReal(false)} onConfirm={async () => { setConfirmReal(false); await save(true); }} />
      <ConfirmDialog open={del} danger title="Remover credenciais da XP?" confirmLabel="Remover"
        message="A senha cifrada será apagada do servidor e a ponte MT5 deixa de ter acesso à conta."
        onCancel={() => { setDel(false); setDelPw(''); }}
        onConfirm={async () => {
          try {
            await api.del('/api/connections/xp_mt5', { currentPassword: delPw });
            toast('Credenciais removidas', 'good'); onChange();
          } catch (e) { toast(e.message, 'bad'); }
          setDel(false); setDelPw('');
        }}>
        <input className={`${inputCls} mt-3`} type="password" placeholder="Sua senha do painel" value={delPw} onChange={(e) => setDelPw(e.target.value)} autoComplete="current-password" />
      </ConfirmDialog>
    </Card>
  );
}

export default function Connections() {
  const { data, reload } = useApi('/api/connections');
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Conexões</h1>
        <p className="text-xs text-ink-3">Contas de corretora usadas pelo bot. As senhas ficam cifradas (AES-256-GCM) no servidor e não aparecem no painel nem nos logs.</p>
      </div>
      {data && !data.vaultReady && <ErrorBox>Cofre de credenciais não configurado no servidor (CREDENTIALS_KEY).</ErrorBox>}
      {data?.rows.map((c) => <XpCard key={c.provider} c={c} onChange={reload} />)}
      <Card title={<span className="inline-flex items-center gap-2"><ShieldCheck size={16} />Mercado Bitcoin (cripto)</span>}>
        <p className="text-sm text-ink-2">A chave da API do Mercado Bitcoin fica no arquivo <span className="font-mono">.env</span> do servidor (API_KEY / API_SECRET), criada <b>sem permissão de saque</b>.</p>
      </Card>
    </div>
  );
}
