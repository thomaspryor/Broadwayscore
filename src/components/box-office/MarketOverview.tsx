/**
 * /box-office "The market" (BRO-5007 v3, unreleased): this week, the same
 * week last year, the season so far and how many shows ran, a sentence on
 * why, the season chart and where this week's money went. Server-rendered;
 * the page renders it only when featureFlags.commercial && boxOfficeV2.
 */
import type { ReactNode } from 'react';
import type { MarketPage } from '@/lib/box-office-display';
import { money } from '@/lib/box-office-display';
import { addDays } from '@/lib/box-office-weeks';

export const EYEBROW = 'text-[11px] font-bold uppercase tracking-[0.1em] text-gray-400';

function Change({ pct, label }: { pct: number | null; label: string }) {
  if (pct == null) return null;
  const up = pct >= 0;
  return (
    <span className="text-xs text-gray-400">
      <span className={up ? 'text-status-open' : 'text-score-tepid'}>
        <span aria-hidden="true">{up ? '▲' : '▼'}</span>
        <span className="sr-only">{up ? 'up ' : 'down '}</span>
        {Math.round(Math.abs(pct))}%
      </span>{' '}
      {label}
    </span>
  );
}

function Tile({ label, value, children }: { label: string; value: string; children?: ReactNode }) {
  return (
    <div className="bg-surface-overlay/60 rounded-xl p-3.5 flex flex-col gap-1 min-w-0">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="text-[24px] sm:text-[28px] font-extrabold leading-tight tabular-nums text-white">{value}</div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

const CHART = { W: 720, H: 240, LEFT: 46, RIGHT: 10, TOP: 10, BOTTOM: 24 };
const MONTH_TICKS: Array<[number, string]> = [[7, 'Jul'], [10, 'Oct'], [1, 'Jan'], [4, 'Apr'], [6, 'Jun']];

function SeasonChart({ c, week }: { c: MarketPage['seasonChart']; week: string }) {
  const n = Math.max(c.lastSeason.length, c.range.length, c.thisSeason.length);
  const values = [...c.thisSeason, ...c.lastSeason, ...c.range.flatMap((r) => (r ? [r.min, r.max] : []))].filter((v): v is number => v != null);
  if (!values.length || n < 2) return null;
  const step = 10_000_000;
  const lo = Math.max(0, Math.floor(Math.min(...values) / step) * step);
  const hi = Math.ceil(Math.max(...values) / step) * step;
  const { W, H, LEFT, RIGHT, TOP, BOTTOM } = CHART;
  const x = (i: number) => LEFT + (i / (n - 1)) * (W - LEFT - RIGHT);
  const y = (v: number) => TOP + (1 - (v - lo) / (hi - lo || 1)) * (H - TOP - BOTTOM);
  const line = (s: Array<number | null>) => s.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(' ');
  const bandIdx = c.range.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
  const band = bandIdx.length
    ? `${bandIdx.map((i) => `${x(i).toFixed(1)},${y(c.range[i]!.max).toFixed(1)}`).join(' ')} ${bandIdx.slice().reverse().map((i) => `${x(i).toFixed(1)},${y(c.range[i]!.min).toFixed(1)}`).join(' ')}`
    : null;
  const ticks: number[] = [];
  for (let t = lo; t <= hi; t += step) ticks.push(t);
  const months = MONTH_TICKS.map(([m, text]) => {
    const i = Array.from({ length: n }, (_, k) => k).find((k) => Number(addDays(c.firstWeek, 7 * k).slice(5, 7)) === m);
    return i == null ? null : { i, text };
  }).filter((t): t is { i: number; text: string } => !!t);
  const lastThis = c.thisSeason.length - 1;
  const nowGross = c.thisSeason[lastThis];
  const label = `Weekly gross of all of Broadway, ${c.thisLabel} so far against ${c.lastLabel} and the range of ${c.rangeLabel}`;
  return (
    <div className="bg-surface-overlay/60 rounded-xl px-2.5 sm:px-3.5 pt-3 pb-2 flex flex-col gap-2">
      <div className={EYEBROW}>Weekly gross, all of Broadway · this season vs last</div>
      {/* Phones scroll the chart sideways rather than shrink its labels to unreadable. */}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Chart, scrolls sideways on small screens">
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[600px] h-auto" role="img" aria-label={label}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={LEFT} x2={W - RIGHT} y1={y(t)} y2={y(t)} className="stroke-white/10" />
            <text x={LEFT - 5} y={y(t) + 4} textAnchor="end" fontSize="12" className="fill-fg-muted">${t / 1_000_000}M</text>
          </g>
        ))}
        {band && <polygon points={band} className="fill-white/10" />}
        <polyline points={line(c.lastSeason)} fill="none" className="stroke-gray-400" strokeWidth={1.5} strokeDasharray="4 3" />
        <polyline points={line(c.thisSeason)} fill="none" className="stroke-brand" strokeWidth={2.5} strokeLinejoin="round" />
        {nowGross != null && <circle cx={x(lastThis)} cy={y(nowGross)} r={4} className="fill-brand" />}
        {months.map((m) => (
          <text key={m.text} x={x(m.i)} y={H - 6} fontSize="12" textAnchor="middle" className="fill-fg-muted">{m.text}</text>
        ))}
      </svg>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-2.5 rounded-sm bg-white/10" />Range of the three seasons before ({c.rangeLabel})</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3.5 border-t-2 border-dashed border-current text-gray-400" />Last season ({c.lastLabel})</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3.5 h-0.5 bg-brand" />This season{nowGross != null ? ` · ${money(nowGross, 1)} this week` : ''}</span>
      </div>
      <span className="sr-only">Week ending {week}.</span>
    </div>
  );
}

const SHARE_TONES = ['bg-brand', 'bg-brand/75', 'bg-brand/55', 'bg-brand/40'];

function ShareBar({ share }: { share: MarketPage['share'] }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className={EYEBROW}>Where this week’s money went</div>
      <div className="flex h-9 rounded-lg overflow-hidden text-[11px] font-bold" role="img"
        aria-label={`${share.top.map((t) => `${t.title} ${Math.round(t.share * 100)}%`).join(', ')}, ${share.otherCount} other shows ${Math.round(share.otherShare * 100)}%`}>
        {share.top.map((t, i) => (
          <div key={t.title} className={`${SHARE_TONES[i]} flex items-center justify-center text-surface`} style={{ width: `${t.share * 100}%` }}>
            {Math.round(t.share * 100)}%
          </div>
        ))}
        <div className="bg-white/10 flex items-center justify-center text-gray-300 flex-1">
          <span className="truncate px-1">{share.otherCount} other shows · {Math.round(share.otherShare * 100)}%</span>
        </div>
      </div>
      <ol className="m-0 p-0 list-none grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-1 text-[13px] text-gray-300">
        {share.top.map((t, i) => (
          <li key={t.title} className="flex items-center gap-2 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-sm shrink-0 ${SHARE_TONES[i]}`} />
            <span className="truncate">{t.title}</span>
            <span className="text-white font-semibold tabular-nums shrink-0">{money(t.gross)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function MarketOverview({ page }: { page: MarketPage }) {
  const t = page.tiles;
  return (
    <section className="card p-4 sm:p-6 mb-8 flex flex-col gap-5" aria-labelledby="market-heading">
      <h2 id="market-heading" className="m-0 text-[12px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none">The market</h2>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        <Tile label="This week" value={money(t.gross, 1)}>
          <Change pct={t.lastWeekPct} label="vs last week" />
        </Tile>
        <Tile label="Same week last year" value={t.lastYearGross != null ? money(t.lastYearGross, 1) : '–'}>
          <Change pct={t.lastYearPct} label="now vs then" />
        </Tile>
        {t.seasonGross != null && (
          <Tile label={`Season so far (${t.seasonWeeks} ${t.seasonWeeks === 1 ? 'week' : 'weeks'})`} value={money(t.seasonGross, 1)}>
            <Change pct={t.vsLastSeasonPct} label="vs last season" />
            <Change pct={t.vsTwoBackPct} label={`vs ${t.twoBackLabel}`} />
          </Tile>
        )}
        <Tile label="Shows running" value={String(t.shows)}>
          <span className="text-xs text-gray-400">top 4 took {Math.round(t.topFourShare * 100)}% of the money</span>
        </Tile>
      </div>
      {page.story && <p className="m-0 text-[15px] leading-relaxed text-white">{page.story}</p>}
      <SeasonChart c={page.seasonChart} week={page.week} />
      <ShareBar share={page.share} />
    </section>
  );
}
