import { getAnalystRecoupTrend, monthLabel } from '@/lib/recoup-story';

/**
 * BRO-5505: the analyst's "Estimated percentage recouped" over time, as a
 * step chart under the show card's estimate bar. Each band is the range he
 * gave, from the post that set it to the next change. Renders nothing when
 * getAnalystRecoupTrend has no trend to show.
 */
const W = 320;
const H = 92;
const LEFT = 40;
const RIGHT = 8;
const TOP = 6;
const BOTTOM = 20;
const TICKS = [0, 50, 100];

export default function AnalystRecoupTrendChart({ history, asOf }: { history: unknown; asOf?: string | null }) {
  const trend = getAnalystRecoupTrend(history, asOf);
  if (!trend) return null;
  const t0 = Date.parse(trend.start);
  const span = Math.max(1, Date.parse(trend.end) - t0);
  const x = (iso: string) => LEFT + ((Date.parse(iso) - t0) / span) * (W - LEFT - RIGHT);
  const y = (pct: number) => TOP + (1 - Math.min(100, pct) / 100) * (H - TOP - BOTTOM);
  const mid = trend.steps
    .map((s, i) => `${i ? 'L' : 'M'}${x(s.from).toFixed(1)},${y((s.low + s.high) / 2).toFixed(1)} H${x(s.to).toFixed(1)}`)
    .join(' ');

  return (
    <div className="mt-3" data-testid="analyst-recoup-trend">
      <p className="text-[11px] text-gray-400 mb-1">
        Estimate over time: <span className="text-gray-300">{trend.summary}</span>
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full max-w-sm h-auto" role="img" aria-label={`Estimated percentage recouped over time: ${trend.summary}`}>
        {TICKS.map((t) => (
          <g key={t}>
            <line x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} className="stroke-white/10" />
            <text x={LEFT - 5} y={y(t) + 4} textAnchor="end" fontSize="12" className="fill-gray-500">{t}%</text>
          </g>
        ))}
        {trend.steps.map((s) => (
          <rect
            key={s.from}
            x={x(s.from)}
            width={Math.max(1, x(s.to) - x(s.from))}
            y={y(s.high)}
            height={Math.max(2, y(s.low) - y(s.high))}
            className="fill-brand/30"
          />
        ))}
        <path d={mid} fill="none" className="stroke-brand" strokeWidth={1.5} strokeLinejoin="round" />
        <text x={LEFT} y={H - 4} fontSize="12" className="fill-gray-500">{monthLabel(trend.start)}</text>
        {monthLabel(trend.end) !== monthLabel(trend.start) && (
          <text x={W - RIGHT} y={H - 4} fontSize="12" textAnchor="end" className="fill-gray-500">{monthLabel(trend.end)}</text>
        )}
      </svg>
    </div>
  );
}
