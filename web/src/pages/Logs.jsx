import { useState } from 'react';
import { useBot } from '../context.js';
import { useApi } from '../hooks/useApi.js';
import { qs } from '../services/api.js';
import { Card, Badge, SEVERITY_TONE, Pagination, Empty, Select } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { time } from '../services/format.js';

const LEVELS = ['INFO', 'WARNING', 'ERROR', 'TRADE', 'CRITICAL'];
const CATS = ['', 'SYSTEM', 'BROKER', 'MARKET', 'STRATEGY', 'RISK', 'TRADE', 'ERROR', 'SECURITY'];

export default function Logs() {
  const { account, tick } = useBot();
  const [levels, setLevels] = useState(LEVELS);
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const severity = levels.length === LEVELS.length ? '' : levels.join(',');
  const { data } = useApi(`/api/events${qs({ account, severity, category, page, pageSize: 100 })}`, tick, { minIntervalMs: 2000, enabled: levels.length > 0 });
  const toggle = (l) => { setLevels(levels.includes(l) ? levels.filter((x) => x !== l) : [...levels, l]); setPage(1); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Logs</h1>
        <ExportButton type="history" account={account} label="Histórico CSV" />
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {LEVELS.map((l) => (
            <button key={l} type="button" onClick={() => toggle(l)} aria-pressed={levels.includes(l)}
              className={`rounded-md border px-2.5 py-1 text-xs font-semibold ${levels.includes(l) ? 'border-series-1/50 bg-series-1/15 text-ink' : 'border-border text-ink-3'}`}>{l}</button>
          ))}
          <Select className="ml-auto w-44" value={category} onChange={(v) => { setCategory(v); setPage(1); }} options={CATS.map((c) => ({ value: c, label: c ? `[${c}]` : 'Todas categorias' }))} />
        </div>
      </Card>
      <Card pad={false}>
        {!levels.length || !data?.rows?.length ? <Empty>Nenhum log.</Empty> : (
          <ul className="divide-y divide-border/60 font-mono text-xs">
            {data.rows.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => setOpen(open === e.id ? null : e.id)} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-2/60">
                  <span className="shrink-0 text-ink-3">{time(e.created_at)}</span>
                  <Badge tone={SEVERITY_TONE[e.severity]} className="shrink-0 font-mono">{e.severity}</Badge>
                  <span className="shrink-0 text-ink-3">[{e.category}]</span>
                  <span className="min-w-0 flex-1 break-words text-ink">{e.message}</span>
                </button>
                {open === e.id && e.metadata && <pre className="overflow-x-auto bg-bg px-3 py-2 text-[11px] text-ink-2">{JSON.stringify(e.metadata, null, 2)}</pre>}
              </li>
            ))}
          </ul>
        )}
        <Pagination page={page} pageSize={100} total={data?.total} onPage={setPage} />
      </Card>
      <p className="text-xs text-ink-3">Segredos (API key, secret, tokens, senhas) são mascarados antes de gravar qualquer log.</p>
    </div>
  );
}
