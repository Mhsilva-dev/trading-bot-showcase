import { Download } from 'lucide-react';

// Download direto (GET com cookie de sessão).
export function ExportButton({ type, account, label = 'CSV' }) {
  return (
    <a href={`/api/export/${type}.csv?account=${account}`} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-ink-2 hover:bg-surface-2" download>
      <Download size={14} />{label}
    </a>
  );
}
