/**
 * /box-office "How the new musicals are selling" (BRO-5007 v3, unreleased):
 * gross per seat week by week from first preview, against the middle half of
 * new musicals since the cohort's first year and a few past examples.
 * Server-rendered behind featureFlags.commercial && boxOfficeV2.
 */
import type { MarketPage } from '@/lib/box-office-display';
import { shortTitle } from '@/lib/box-office-display';

const W = 720;
const H = 260;
const LEFT = 40;
const RIGHT = 10;
const TOP = 10;
const BOTTOM = 24;

/** Current shows get the brand palette; past examples are muted dashes. */
const CURRENT_TONES = ['stroke-brand', 'stroke-status-open', 'stroke-accent-purple', 'stroke-score-tepid'];
const CURRENT_SWATCH = ['bg-brand', 'bg-status-open', 'bg-accent-purple', 'bg-score-tepid'];

export default function NewMusicalsChart({ cohort }: { cohort: MarketPage['cohort'] }) {
  const n = cohort.weeks;
  const values = [
    ...cohort.band.flatMap((b) => (b ? [b.p25, b.p75, b.median] : [])),
    ...cohort.lines.flatMap((l) => l.series.filter((v): v is number => v != null)),
  ];
  if (!values.length || !cohort.lines.length) return null;
  const step = 50;
  const hi = Math.ceil(Math.max(...values) / step) * step;
  const x = (i: number) => LEFT + (i / Math.max(1, n - 1)) * (W - LEFT - RIGHT);
  const y = (v: number) => TOP + (1 - v / (hi || 1)) * (H - TOP - BOTTOM);
  const path = (s: Array<number | null>) => {
    let d = '';
    let pen = false;
    s.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const idx = cohort.band.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  const band = idx.length
    ? `${idx.map((i) => `${x(i).toFixed(1)},${y(cohort.band[i]!.p75).toFixed(1)}`).join(' ')} ${idx.slice().reverse().map((i) => `${x(i).toFixed(1)},${y(cohort.band[i]!.p25).toFixed(1)}`).join(' ')}`
    : null;
  const median = path(cohort.band.map((b) => b?.median ?? null));
  const ticks = Array.from({ length: hi / step + 1 }, (_, k) => k * step);
  const weekTicks = [1, ...Array.from({ length: Math.floor(n / 5) }, (_, k) => (k + 1) * 5)].filter((w) => w <= n);
  const current = cohort.lines.filter((l) => l.kind === 'current');
  const examples = cohort.lines.filter((l) => l.kind === 'example');
  return (
    <section className="card p-4 sm:p-6 mb-8 flex flex-col gap-4" aria-labelledby="new-musicals-heading">
      <h2 id="new-musicals-heading" className="m-0 text-xl font-bold text-white">How the new musicals are selling</h2>
      <p className="m-0 text-sm leading-relaxed text-gray-300">
        Gross per seat, week by week from first preview, against the middle half of the {cohort.musicals} new musicals since {cohort.fromYear} (shaded)
        and past examples. Selling well is not the same as paying back. That depends on costs, which the Profitability Scorecard covers.
      </p>
      <div className="bg-surface-overlay/60 rounded-xl px-2.5 sm:px-3.5 pt-3 pb-2 flex flex-col gap-2">
        {/* Phones scroll the chart sideways rather than shrink its labels to unreadable. */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Chart, scrolls sideways on small screens">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[600px] h-auto" role="img"
          aria-label={`Gross per seat by week from first preview for ${current.map((l) => l.title).join(', ')}, against the middle half of new musicals since ${cohort.fromYear}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} className="stroke-white/10" />
              <text x={LEFT - 5} y={y(t) + 4} textAnchor="end" fontSize="12" className="fill-gray-500">${t}</text>
            </g>
          ))}
          {band && <polygon points={band} className="fill-white/10" />}
          {median && <path d={median} fill="none" className="stroke-gray-300" strokeWidth={1.5} />}
          {examples.map((l) => (
            <path key={l.title} d={path(l.series)} fill="none" className="stroke-gray-500" strokeWidth={1.3} strokeDasharray="4 3" />
          ))}
          {current.map((l, i) => (
            <path key={l.title} d={path(l.series)} fill="none" className={CURRENT_TONES[i % CURRENT_TONES.length]} strokeWidth={2.5} strokeLinejoin="round" />
          ))}
          {weekTicks.map((w) => (
            <text key={w} x={x(w - 1)} y={H - 6} fontSize="12" textAnchor="middle" className="fill-gray-500">wk {w}</text>
          ))}
        </svg>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
          <span className="inline-flex items-center gap-1.5"><span className="w-3 h-2.5 rounded-sm bg-white/10" />Middle half</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-0.5 bg-gray-300" />Typical new musical</span>
          {examples.map((l) => (
            <span key={l.title} className="inline-flex items-center gap-1.5">
              <span className="w-3.5 border-t-2 border-dashed border-current text-fg-muted" />{l.title}{l.tag ? ` (${l.tag})` : ''}
            </span>
          ))}
          {current.map((l, i) => (
            <span key={l.title} className="inline-flex items-center gap-1.5">
              <span className={`w-3.5 h-0.5 ${CURRENT_SWATCH[i % CURRENT_SWATCH.length]}`} />{shortTitle(l.title)}
            </span>
          ))}
        </div>
      </div>
      {cohort.story && <p className="m-0 text-[15px] leading-relaxed text-white">{cohort.story}</p>}
    </section>
  );
}
