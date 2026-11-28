import type { MultiplePoint } from '@/lib/box-office-status';
import { formatCurrency } from '@/lib/formatting';
import { multipleTicks } from '@/lib/box-office-v2-display';

/**
 * One bar per week (BRO-5007). Mode "multiple": gross as a share of the show's
 * break-even (green at or above 100%, amber below), a dashed 100% line and the
 * typical Broadway show that week as a cream line; the Profitability Scorecard's
 * cost section. Mode "gross": plain weekly grosses in dollars; the Box Office
 * Scorecard. Unreported weeks are gaps, never zero.
 */
interface Props {
  /** Oldest first. */
  points: MultiplePoint[];
  mode: 'multiple' | 'gross';
  /** viewBox size; it scales to the container, so a phone chart uses a narrower width to keep 12px text legible. */
  width?: number;
  height?: number;
  label: string;
}

const DEFAULT_W = 688;
const LEFT_MULTIPLE = 44;
const LEFT_GROSS = 50;
const RIGHT = 6;
const TOP = 8;
const AXIS = 22;

function monthLabel(week: string): string {
  const d = new Date(`${week}T12:00:00Z`);
  return `${d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })} ${String(d.getUTCFullYear()).slice(2)}`;
}

function niceMax(v: number, steps: number[]): number {
  // Past the list, round up to an even number so multipleTicks (steps of 2 above 8x) ends on the max.
  return steps.find((s) => s >= v) ?? Math.ceil(v / 2) * 2;
}

export default function WeeklyBarChart({ points, mode, width = DEFAULT_W, height = 190, label }: Props) {
  const W = width;
  const LEFT = mode === 'gross' ? LEFT_GROSS : LEFT_MULTIPLE;
  if (!points.length) return null;
  const H = height;
  const plotH = H - TOP - AXIS;
  const bottom = TOP + plotH;
  const values = points.map((p) => (mode === 'multiple' ? p.multiple : p.gross));
  const markets = mode === 'multiple' ? points.map((p) => p.market) : [];
  const peak = Math.max(...values.filter((v): v is number => v != null), ...markets.filter((v): v is number => v != null), mode === 'multiple' ? 1.2 : 0);
  const max = mode === 'multiple' ? niceMax(peak * 1.05, [1.5, 2, 2.5, 3, 4, 5, 6, 8]) : niceMax(peak * 1.05, [250_000, 500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 3_000_000, 4_000_000, 5_000_000]);
  const y = (v: number) => bottom - (v / max) * plotH;
  const slot = (W - LEFT - RIGHT) / points.length;
  const barW = Math.max(2, Math.min(18, slot * 0.8));
  const x = (i: number) => LEFT + slot * i + (slot - barW) / 2;

  const ticks = mode === 'multiple' ? multipleTicks(max) : [0, max / 2, max];
  const tickText = (t: number) => (mode === 'multiple' ? `${Math.round(t * 100)}%` : formatCurrency(t));

  const months: Array<{ i: number; text: string }> = [];
  let lastMonth = '';
  points.forEach((p, i) => {
    const m = p.week.slice(0, 7);
    if (m !== lastMonth) {
      const mo = Number(p.week.slice(5, 7));
      if (i > 0 && x(i) < W - RIGHT - 44 && (points.length <= 8 || mo % 3 === 1)) months.push({ i, text: monthLabel(p.week) });
      lastMonth = m;
    }
  });

  const marketLine = markets
    .map((m, i) => (m == null ? null : `${(x(i) + barW / 2).toFixed(1)},${y(Math.min(m, max)).toFixed(1)}`))
    .filter((s): s is string => s != null)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto" role="img" aria-label={label}>
      {ticks.map((t) => (
        <g key={t}>
          {!(mode === 'multiple' && t === 1) && <line x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} className="stroke-white/10" />}
          <text x={LEFT - 5} y={y(t) + 4} textAnchor="end" fontSize="12" className="fill-fg-muted">{tickText(t)}</text>
        </g>
      ))}
      {values.map((v, i) => {
        if (v == null) return null;
        const p = points[i];
        const tone = mode === 'gross' ? 'fill-brand/70' : v >= 1 ? 'fill-status-open' : 'fill-score-tepid';
        const top = y(Math.min(v, max));
        const title = mode === 'multiple'
          ? `Week ending ${p.week}: ${Math.round(v * 100)}% of break-even (${formatCurrency(p.gross)})${p.market != null ? `. Typical Broadway show: ${Math.round(p.market * 100)}%` : ''}`
          : `Week ending ${p.week}: ${formatCurrency(p.gross)}`;
        return (
          <rect key={p.week} x={x(i)} y={top} width={barW} height={Math.max(0.5, bottom - top)} rx={1.5} className={tone}>
            <title>{title}</title>
          </rect>
        );
      })}
      {mode === 'multiple' && (
        <line x1={LEFT} x2={W - RIGHT} y1={y(1)} y2={y(1)} className="stroke-gray-200" strokeWidth={1.3} strokeDasharray="4 3" />
      )}
      {marketLine && <polyline points={marketLine} fill="none" className="stroke-accent-cream" strokeWidth={2} strokeLinejoin="round" />}
      {months.map((m) => (
        <text key={m.i} x={x(m.i)} y={H - 5} fontSize="12" className="fill-fg-muted">{m.text}</text>
      ))}
    </svg>
  );
}
