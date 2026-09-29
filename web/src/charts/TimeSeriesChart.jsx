import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Empty } from '../components/ui.jsx';
import { brl, shortDate, num } from '../services/format.js';

// Série temporal única (patrimônio, P/L acumulado ou drawdown). Uma série =
// sem legenda (o título do card nomeia). Crosshair + tooltip no hover.
export function TimeSeriesChart({ data, x = 'ts', y, color = 'var(--color-series-1)', height = 220, kind = 'brl', baseline, xIsUnix = false }) {
  if (!data?.length) return <Empty>Sem dados no período.</Empty>;
  const fmtY = kind === 'brl' ? (v) => brl(v) : (v) => `${num(v, 2)}%`;
  const toIso = (v) => (xIsUnix ? new Date(v * 1000).toISOString() : v);
  const id = `g-${y}-${Math.round(Math.random() * 1e6)}`;
  return (
    <div style={{ width: '100%', height }}>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.28} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="0" vertical={false} />
          <XAxis dataKey={x} tickFormatter={(v) => shortDate(toIso(v))} stroke="var(--color-ink-3)" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={48} />
          <YAxis tickFormatter={fmtY} stroke="var(--color-ink-3)" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={kind === 'brl' ? 76 : 52} domain={['auto', 'auto']} />
          {baseline !== undefined && <ReferenceLine y={baseline} stroke="var(--color-ink-3)" strokeDasharray="4 4" />}
          <Tooltip
            cursor={{ stroke: 'var(--color-ink-3)', strokeWidth: 1 }}
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: 'var(--color-ink-2)' }}
            itemStyle={{ color: 'var(--color-ink)' }}
            labelFormatter={(v) => shortDate(toIso(v))}
            formatter={(v) => [fmtY(v), '']}
            separator=""
          />
          <Area type="monotone" dataKey={y} stroke={color} strokeWidth={2} fill={`url(#${id})`} dot={false} activeDot={{ r: 4, stroke: 'var(--color-surface)', strokeWidth: 2 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
