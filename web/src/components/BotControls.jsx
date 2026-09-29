import { useState } from 'react';
import { Play, Pause, CircleStop, RefreshCw, OctagonX, ShieldCheck } from 'lucide-react';
import { api } from '../services/api.js';
import { useBot } from '../context.js';
import { Button, ConfirmDialog, toast } from './ui.jsx';

const LABEL = { start: 'Iniciar', pause: 'Pausar', stop: 'Parar', sync: 'Sincronizar', emergency_stop: 'EMERGENCY STOP', clear_emergency: 'Liberar emergência', reset_paper: 'Reset do paper' };

// Envia o comando e acompanha até o bot processar (fila no banco).
export async function sendCommand(account, command, extra = {}) {
  const r = await api.post('/api/bot/command', { account, command, ...extra });
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 800));
    const c = await api.get(`/api/bot/command/${r.commandId}`);
    if (c.status === 'DONE') return { ok: true };
    if (c.status === 'FAILED') throw new Error(c.result?.error || 'Comando recusado pelo bot');
  }
  return { ok: true, pending: true };
}

export function useCommand() {
  const { account } = useBot();
  const [busy, setBusy] = useState(null);
  const run = async (command, extra) => {
    setBusy(command);
    try {
      const r = await sendCommand(account, command, extra);
      toast(r.pending ? `${LABEL[command]}: enviado. O bot ainda não respondeu (está online?)` : `${LABEL[command]}: executado`, r.pending ? 'warn' : 'good');
      return true;
    } catch (e) {
      toast(`${LABEL[command]}: ${e.message}`, 'bad');
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { run, busy };
}

export function BotControls() {
  const { status, account } = useBot();
  const { run, busy } = useCommand();
  const [confirmStart, setConfirmStart] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const desired = status?.control?.desired;
  const emergency = status?.control?.emergency;
  const isLive = account === 'live';

  return (
    <div className="flex flex-wrap gap-2">
      {emergency ? (
        <Button variant="warn" onClick={() => setConfirmClear(true)} disabled={!!busy}><ShieldCheck size={16} />Liberar emergência</Button>
      ) : (
        <Button variant="good" onClick={() => (isLive ? setConfirmStart(true) : run('start'))} disabled={!!busy || desired === 'RUNNING'}><Play size={16} />Iniciar</Button>
      )}
      <Button onClick={() => run('pause')} disabled={!!busy || desired === 'PAUSED' || emergency}><Pause size={16} />Pausar</Button>
      <Button onClick={() => run('stop')} disabled={!!busy || desired === 'STOPPED'}><CircleStop size={16} />Parar</Button>
      <Button onClick={() => run('sync')} disabled={!!busy}><RefreshCw size={16} className={busy === 'sync' ? 'animate-spin' : ''} />Sincronizar</Button>
      <ConfirmDialog open={confirmStart} danger title="Iniciar bot com DINHEIRO REAL?" confirmLabel="Iniciar LIVE"
        message="O bot poderá enviar ordens reais à corretora conforme a estratégia e os limites de risco configurados. Nenhum sistema garante lucro."
        onCancel={() => setConfirmStart(false)} onConfirm={async () => { await run('start', { confirm: true }); setConfirmStart(false); }} />
      <ConfirmDialog open={confirmClear} title="Liberar a emergência?" confirmLabel="Liberar"
        message="O bot continuará PARADO. Depois de liberar, você ainda precisa clicar em Iniciar; ele sincroniza com a corretora antes de operar."
        onCancel={() => setConfirmClear(false)} onConfirm={async () => { await run('clear_emergency', { confirm: true }); setConfirmClear(false); }} />
    </div>
  );
}

export function EmergencyButton({ compact = false }) {
  const { account, status } = useBot();
  const [open, setOpen] = useState(false);
  const emergency = status?.control?.emergency;
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)} disabled={emergency} className={compact ? 'min-h-9 px-2.5 text-xs font-bold' : 'w-full font-bold'} title="Interromper novas ordens imediatamente">
        <OctagonX size={compact ? 16 : 18} />{compact ? <span className="hidden sm:inline">{emergency ? 'TRADING DISABLED' : 'EMERGENCY STOP'}</span> : (emergency ? 'TRADING DISABLED' : 'EMERGENCY STOP')}
      </Button>
      <ConfirmDialog open={open} danger title="EMERGENCY STOP" confirmLabel="Interromper agora"
        message={`Tem certeza que deseja interromper novas operações na conta ${account.toUpperCase()}? Nenhuma ordem (nem de saída) será enviada até você liberar a emergência.`}
        onCancel={() => setOpen(false)}
        onConfirm={async () => {
          try {
            await api.post('/api/bot/command', { account, command: 'emergency_stop', confirm: true });
            toast('TRADING DISABLED — emergência registrada no log', 'bad');
          } catch (e) { toast(e.message, 'bad'); }
          setOpen(false);
        }} />
    </>
  );
}
