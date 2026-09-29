import { useState } from 'react';
import { Bot } from 'lucide-react';
import { api, setCsrf } from '../services/api.js';
import { Button, ErrorBox, Field, inputCls } from '../components/ui.jsx';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/api/auth/login', { username, password });
      setCsrf(r.csrfToken);
      onLogin(r.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="fade-in w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="rounded-xl bg-series-1/15 p-2.5 text-series-1"><Bot size={24} /></div>
          <div>
            <h1 className="text-lg font-semibold">Trading Bot</h1>
            <p className="text-xs text-ink-3">Painel de monitoramento</p>
          </div>
        </div>
        <div className="space-y-4">
          <Field label="Usuário">
            <input className={inputCls} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required maxLength={64} />
          </Field>
          <Field label="Senha">
            <input className={inputCls} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required maxLength={256} />
          </Field>
          <ErrorBox>{error}</ErrorBox>
          <Button type="submit" variant="primary" className="w-full" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</Button>
        </div>
      </form>
    </div>
  );
}
