'use client';

/**
 * /box-office "How full, and at what price?" (BRO-5007 v3, unreleased): each
 * show by share of seats sold (across) and average ticket (up), dot size by
 * house size. Hover or focus a dot for its numbers; on a phone, tap. Loaded
 * with dynamic() from PriceMapLazy only when featureFlags.commercial &&
 * boxOfficeV2.
 *
 * Phones get their own chart that fits the screen width: smaller dots, names
 * only on the few outliers, and the rest listed by corner underneath. The
 * outliers and corners come in as props (MarketPage.priceMapPhone, built on
 * the server) so this client chart imports no held module. Wider screens keep
 * the full labelled chart.
 */
import { useState } from 'react';
import type { MarketPage } from '@/lib/box-office-display';

type Dot = MarketPage['priceMap'][number];
type PhoneGroups = MarketPage['priceMapPhone'];

type Frame = { w: number; h: number; left: number; right: number; top: number; bottom: number; charW: number; labelH: number };

const DESKTOP: Frame = { w: 720, h: 420, left: 46, right: 14, top: 14, bottom: 30, charW: 6.4, labelH: 14 };
const PHONE: Frame = { w: 360, h: 300, left: 38, right: 8, top: 10, bottom: 26, charW: 6.4, labelH: 14 };
/** Phone tap target radius in chart units (about 22 px across on a 390 px screen). */
const PHONE_HIT_R = 14;

export type LabelSide = 'right' | 'left' | 'below' | 'above';

/**
 * Greedy label placement: biggest houses first. A label goes right of its dot,
 * or left when the right side runs off the chart or hits something; a label
 * with no clear side is skipped (the dot keeps its hover and tap). `only`
 * limits which dots get a label; every dot still counts as an obstacle. With
 * `vertical`, a label that fits neither side may sit centred below or above.
 */
export function placeLabels(
  dots: Array<{ x: number; y: number; r: number; label: string; slug: string }>,
  frame: Frame = DESKTOP,
  only?: Set<string>,
  vertical = false,
): Map<string, LabelSide> {
  const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  const shown = new Map<string, LabelSide>();
  for (const d of [...dots].sort((a, b) => b.r - a.r)) {
    if (only && !only.has(d.slug)) continue;
    const w = d.label.length * frame.charW;
    const mid = d.y - frame.labelH / 2;
    const sides: Array<[LabelSide, number, number, number]> = [
      ['right', d.x + d.r + 3, d.x + d.r + 3 + w, mid],
      ['left', d.x - d.r - 3 - w, d.x - d.r - 3, mid],
    ];
    if (vertical) {
      sides.push(['below', d.x - w / 2, d.x + w / 2, d.y + d.r + 1]);
      sides.push(['above', d.x - w / 2, d.x + w / 2, d.y - d.r - 1 - frame.labelH]);
    }
    for (const [side, x0, x1, y0] of sides) {
      const y1 = y0 + frame.labelH;
      if (x1 > frame.w - frame.right || x0 < frame.left) continue;
      if ((side === 'below' || side === 'above') && (y0 < frame.top || y1 > frame.h - frame.bottom)) continue;
      const hit = placed.some((p) => x0 < p.x1 && x1 > p.x0 && y0 < p.y1 && y1 > p.y0)
        || dots.some((o) => o.slug !== d.slug && o.x + o.r > x0 && o.x - o.r < x1 && o.y + o.r > y0 && o.y - o.r < y1);
      if (hit) continue;
      placed.push({ x0, x1, y0, y1 });
      shown.set(d.slug, side);
      break;
    }
  }
  return shown;
}

function axes(dots: Dot[]) {
  const capLo = Math.min(60, Math.floor(Math.min(...dots.map((d) => d.capacity)) / 10) * 10);
  const capHi = Math.max(100, Math.ceil(Math.max(...dots.map((d) => d.capacity)) / 5) * 5);
  const atpHi = Math.ceil(Math.max(...dots.map((d) => d.atp)) / 50) * 50;
  const atpLo = Math.max(0, Math.floor(Math.min(...dots.map((d) => d.atp)) / 50) * 50);
  const capTicks: number[] = [];
  for (let c = Math.ceil(capLo / 10) * 10; c <= capHi; c += 10) capTicks.push(c);
  const atpTicks: number[] = [];
  for (let a = atpLo; a <= atpHi; a += 50) atpTicks.push(a);
  return { capLo, capHi, atpLo, atpHi, capTicks, atpTicks, maxSeats: Math.max(...dots.map((d) => d.seats)) };
}

/** Dot centres and radii for a frame; phones draw smaller dots. */
function positions(dots: Dot[], f: Frame, phone: boolean) {
  const ax = axes(dots);
  const [rMin, rRange] = phone ? [2.5, 4.5] : [4, 8];
  return dots.map((d) => ({
    ...d,
    x: f.left + ((d.capacity - ax.capLo) / (ax.capHi - ax.capLo)) * (f.w - f.left - f.right),
    y: f.top + (1 - (d.atp - ax.atpLo) / (ax.atpHi - ax.atpLo || 1)) * (f.h - f.top - f.bottom),
    r: rMin + rRange * Math.sqrt(d.seats / ax.maxSeats),
  }));
}

type ChartProps = {
  dots: Dot[];
  frame: Frame;
  phone: boolean;
  groups: PhoneGroups;
  active: string | null;
  setActive: (fn: string | null | ((a: string | null) => string | null)) => void;
};

function Chart({ dots, frame: f, phone, groups, active, setActive }: ChartProps) {
  const ax = axes(dots);
  const x = (c: number) => f.left + ((c - ax.capLo) / (ax.capHi - ax.capLo)) * (f.w - f.left - f.right);
  const y = (a: number) => f.top + (1 - (a - ax.atpLo) / (ax.atpHi - ax.atpLo || 1)) * (f.h - f.top - f.bottom);
  const pos = positions(dots, f, phone);
  const labelled = placeLabels(pos, f, phone ? new Set(groups.named) : undefined, phone);
  const tickFont = 12;
  const labelFont = 11;
  const medianAtp = phone ? groups.medianAtp : null;
  return (
    <svg
      viewBox={`0 0 ${f.w} ${f.h}`}
      className={phone ? 'block w-full h-auto' : 'block w-full min-w-[600px] h-auto'}
      role="group"
      aria-label="Each show by share of seats sold and average ticket price"
    >
      {ax.capTicks.map((c) => (
        <g key={`c${c}`}>
          <line x1={x(c)} x2={x(c)} y1={f.top} y2={f.h - f.bottom} className="stroke-white/5" />
          <text x={x(c)} y={f.h - (phone ? 8 : 10)} fontSize={tickFont} textAnchor="middle" className={phone ? 'fill-gray-400' : 'fill-fg-muted'}>{phone ? `${c}%` : `${c}% full`}</text>
        </g>
      ))}
      {ax.atpTicks.map((a) => (
        <g key={`a${a}`}>
          <line x1={f.left} x2={f.w - f.right} y1={y(a)} y2={y(a)} className="stroke-white/5" />
          <text x={f.left - (phone ? 4 : 5)} y={y(a) + 4} fontSize={tickFont} textAnchor="end" className={phone ? 'fill-gray-400' : 'fill-fg-muted'}>${a}</text>
        </g>
      ))}
      {phone && medianAtp != null && (
        <g className="stroke-white/25" strokeDasharray="3 3">
          <line x1={x(groups.fullPct)} x2={x(groups.fullPct)} y1={f.top} y2={f.h - f.bottom} />
          <line x1={f.left} x2={f.w - f.right} y1={y(medianAtp)} y2={y(medianAtp)} />
        </g>
      )}
      {!phone && (
        <>
          <text x={f.w - f.right - 4} y={f.top + 12} fontSize="11" textAnchor="end" className="fill-gray-400 font-bold">FULL AND PRICEY →</text>
          <text x={f.w - f.right - 4} y={f.h - f.bottom - 6} fontSize="11" textAnchor="end" className="fill-gray-400 font-bold">FULL BUT CHEAP ↘</text>
          <text x={f.left + 6} y={f.top + 12} fontSize="11" className="fill-gray-400 font-bold">↖ PRICEY WITH EMPTY SEATS</text>
          <text x={f.left + 6} y={f.h - f.bottom - 6} fontSize="11" className="fill-gray-400 font-bold">↙ LOWER PRICES, EMPTY SEATS</text>
        </>
      )}
      {pos.map((d) => (
        <g key={d.slug}>
          <circle
            cx={d.x} cy={d.y} r={d.r}
            className={`${active === d.slug ? 'fill-brand' : 'fill-brand/60'} stroke-surface pointer-events-none`}
            strokeWidth={phone ? 1 : 1.5}
          />
          {/* The hit area: on phones it is larger than the dot so a finger can land on it. */}
          <circle
            cx={d.x} cy={d.y} r={phone ? Math.max(d.r, PHONE_HIT_R) : d.r}
            className="fill-transparent stroke-transparent cursor-pointer outline-none focus-visible:stroke-white"
            strokeWidth={1.5}
            tabIndex={0}
            role="button"
            aria-label={`${d.title}: ${Math.round(d.capacity)}% full, $${Math.round(d.atp)} avg ticket`}
            aria-pressed={active === d.slug}
            // A tap fires mouseenter and focus before click, which already select
            // the dot, so click only ever selects; the ✕, Escape or another dot clear it.
            onClick={() => setActive(d.slug)}
            onFocus={() => setActive(d.slug)}
            onMouseEnter={() => setActive(d.slug)}
            onMouseLeave={() => setActive((a) => (a === d.slug ? null : a))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setActive(null);
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(active === d.slug ? null : d.slug); }
            }}
          >
            <title>{`${d.title}: ${Math.round(d.capacity)}% full, $${Math.round(d.atp)} avg ticket`}</title>
          </circle>
          {labelled.get(d.slug) === 'left' && <text x={d.x - d.r - 3} y={d.y + 4} fontSize={labelFont} textAnchor="end" className="fill-gray-300 pointer-events-none">{d.label}</text>}
          {labelled.get(d.slug) === 'right' && <text x={d.x + d.r + 3} y={d.y + 4} fontSize={labelFont} className="fill-gray-300 pointer-events-none">{d.label}</text>}
          {labelled.get(d.slug) === 'below' && <text x={d.x} y={d.y + d.r + f.labelH - 2} fontSize={labelFont} textAnchor="middle" className="fill-gray-300 pointer-events-none">{d.label}</text>}
          {labelled.get(d.slug) === 'above' && <text x={d.x} y={d.y - d.r - 4} fontSize={labelFont} textAnchor="middle" className="fill-gray-300 pointer-events-none">{d.label}</text>}
        </g>
      ))}
    </svg>
  );
}

/** Under the phone chart: every show, grouped by the corner it sits in. */
function CornerLists({ dots, groups }: { dots: Dot[]; groups: PhoneGroups }) {
  const { medianAtp, corners, fullPct } = groups;
  if (medianAtp == null) return null;
  const bySlug = new Map(dots.map((d) => [d.slug, d]));
  return (
    <div className="flex flex-col gap-3 sm:hidden">
      <p className="m-0 text-xs text-gray-400">
        Full means {fullPct}% of seats sold or more. Pricey means an average ticket of ${Math.round(medianAtp)} or more, the middle show this week. Tap any dot for its numbers.
      </p>
      {corners.map((c) => (
        <div key={c.key} className="flex flex-col gap-1">
          <h3 className="m-0 text-xs font-bold uppercase tracking-wide text-gray-300">{c.title}</h3>
          <ul className="m-0 p-0 list-none flex flex-col">
            {c.slugs.map((slug) => bySlug.get(slug)).filter((s): s is Dot => !!s).map((s) => (
              <li key={s.slug} className="flex items-baseline justify-between gap-3 py-0.5 text-sm">
                <span className="text-white truncate" title={s.title}>{s.label}</span>
                <span className="text-gray-400 tabular-nums shrink-0">{Math.round(s.capacity)}% · ${Math.round(s.atp)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function PriceMap({ dots, groups }: { dots: Dot[]; groups: PhoneGroups }) {
  const [active, setActive] = useState<string | null>(null);
  if (!dots.length) return null;
  const desktopLabelled = placeLabels(positions(dots, DESKTOP, false), DESKTOP);
  const unlabelled = dots.filter((d) => !desktopLabelled.has(d.slug)).map((d) => d.label);
  const sel = dots.find((d) => d.slug === active) ?? null;
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-surface-overlay/60 rounded-xl px-2 sm:px-3.5 pt-3 pb-2 relative">
        <div className="sm:hidden">
          <Chart dots={dots} frame={PHONE} phone groups={groups} active={active} setActive={setActive} />
        </div>
        <div className="hidden sm:block overflow-x-auto">
          <Chart dots={dots} frame={DESKTOP} phone={false} groups={groups} active={active} setActive={setActive} />
        </div>
        {sel && (
          <div className="mt-2 sm:mt-0 sm:absolute sm:bottom-3 sm:right-4 sm:w-72 bg-surface-elevated border border-white/10 rounded-lg px-3 py-2 text-sm text-white flex items-center justify-between gap-3" role="status">
            <span>
              <span className="font-semibold">{sel.title}</span>
              <span className="block text-xs text-gray-400">{Math.round(sel.capacity)}% full · ${Math.round(sel.atp)} avg ticket · {sel.seats.toLocaleString('en-US')} seats</span>
            </span>
            <button type="button" className="text-gray-400 hover:text-white min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0" aria-label="Close" onClick={() => setActive(null)}>✕</button>
          </div>
        )}
      </div>
      <CornerLists dots={dots} groups={groups} />
      {unlabelled.length > 0 && (
        <p className="hidden sm:block m-0 text-xs text-gray-400">Not labelled, to keep the busy spots readable: {unlabelled.join(', ')}. Hover, tab to or tap any dot for its name and numbers.</p>
      )}
    </div>
  );
}
