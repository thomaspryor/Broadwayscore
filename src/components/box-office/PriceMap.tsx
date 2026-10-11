'use client';

/**
 * /box-office "How full, and at what price?" (BRO-5007 v3, unreleased): each
 * show by share of seats sold (across) and average ticket (up), dot size by
 * house size. Hover or focus a dot for its numbers; on a phone, tap. Loaded
 * with dynamic() from PriceMapLazy only when featureFlags.commercial &&
 * boxOfficeV2.
 */
import { useState } from 'react';
import type { MarketPage } from '@/lib/box-office-display';

type Dot = MarketPage['priceMap'][number];

const W = 720;
const H = 420;
const LEFT = 46;
const RIGHT = 14;
const TOP = 14;
const BOTTOM = 30;
const LABEL_H = 14;
const CHAR_W = 6.4;

export type LabelSide = 'right' | 'left';

/**
 * Greedy label placement: biggest houses first. A label goes right of its dot,
 * or left when the right side runs off the chart or hits something; a label
 * with no clear side is skipped (the dot keeps its hover and tap).
 */
export function placeLabels(dots: Array<{ x: number; y: number; r: number; label: string; slug: string }>): Map<string, LabelSide> {
  const placed: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  const shown = new Map<string, LabelSide>();
  for (const d of [...dots].sort((a, b) => b.r - a.r)) {
    const w = d.label.length * CHAR_W;
    const y0 = d.y - LABEL_H / 2;
    const y1 = d.y + LABEL_H / 2;
    const sides: Array<[LabelSide, number, number]> = [
      ['right', d.x + d.r + 3, d.x + d.r + 3 + w],
      ['left', d.x - d.r - 3 - w, d.x - d.r - 3],
    ];
    for (const [side, x0, x1] of sides) {
      if (x1 > W - RIGHT || x0 < LEFT) continue;
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

export default function PriceMap({ dots }: { dots: Dot[] }) {
  const [active, setActive] = useState<string | null>(null);
  if (!dots.length) return null;
  const capLo = Math.min(60, Math.floor(Math.min(...dots.map((d) => d.capacity)) / 10) * 10);
  const capHi = Math.max(100, Math.ceil(Math.max(...dots.map((d) => d.capacity)) / 5) * 5);
  const atpHi = Math.ceil(Math.max(...dots.map((d) => d.atp)) / 50) * 50;
  const atpLo = Math.max(0, Math.floor(Math.min(...dots.map((d) => d.atp)) / 50) * 50);
  const maxSeats = Math.max(...dots.map((d) => d.seats));
  const x = (c: number) => LEFT + ((c - capLo) / (capHi - capLo)) * (W - LEFT - RIGHT);
  const y = (a: number) => TOP + (1 - (a - atpLo) / (atpHi - atpLo || 1)) * (H - TOP - BOTTOM);
  const pos = dots.map((d) => ({ ...d, x: x(d.capacity), y: y(d.atp), r: 4 + 8 * Math.sqrt(d.seats / maxSeats) }));
  const labelled = placeLabels(pos);
  const unlabelled = pos.filter((d) => !labelled.has(d.slug)).map((d) => d.label);
  const capTicks: number[] = [];
  for (let c = Math.ceil(capLo / 10) * 10; c <= capHi; c += 10) capTicks.push(c);
  const atpTicks: number[] = [];
  for (let a = atpLo; a <= atpHi; a += 50) atpTicks.push(a);
  const sel = pos.find((d) => d.slug === active) ?? null;
  return (
    <div className="flex flex-col gap-2">
      <div className="bg-surface-overlay/60 rounded-xl px-2.5 sm:px-3.5 pt-3 pb-2 relative">
        {/* Phones scroll the chart sideways rather than shrink its labels to unreadable. */}
        <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full min-w-[600px] h-auto" role="group" aria-label="Each show by share of seats sold and average ticket price">
          {capTicks.map((c) => (
            <g key={`c${c}`}>
              <line x1={x(c)} x2={x(c)} y1={TOP} y2={H - BOTTOM} className="stroke-white/5" />
              <text x={x(c)} y={H - 10} fontSize="12" textAnchor="middle" className="fill-gray-500">{c}% full</text>
            </g>
          ))}
          {atpTicks.map((a) => (
            <g key={`a${a}`}>
              <line x1={LEFT} x2={W - RIGHT} y1={y(a)} y2={y(a)} className="stroke-white/5" />
              <text x={LEFT - 5} y={y(a) + 4} fontSize="12" textAnchor="end" className="fill-gray-500">${a}</text>
            </g>
          ))}
          <text x={W - RIGHT - 4} y={TOP + 12} fontSize="11" textAnchor="end" className="fill-gray-400 font-bold">FULL AND PRICEY →</text>
          <text x={W - RIGHT - 4} y={H - BOTTOM - 6} fontSize="11" textAnchor="end" className="fill-gray-400 font-bold">FULL BUT CHEAP ↘</text>
          <text x={LEFT + 6} y={TOP + 12} fontSize="11" className="fill-gray-400 font-bold">↖ PRICEY WITH EMPTY SEATS</text>
          <text x={LEFT + 6} y={H - BOTTOM - 6} fontSize="11" className="fill-gray-400 font-bold">↙ LOWER PRICES, EMPTY SEATS</text>
          {pos.map((d) => (
            <g key={d.slug}>
              <circle
                cx={d.x} cy={d.y} r={d.r}
                className={`${active === d.slug ? 'fill-brand' : 'fill-brand/60'} stroke-surface cursor-pointer outline-none focus-visible:stroke-white`}
                strokeWidth={1.5}
                tabIndex={0}
                role="button"
                aria-label={`${d.title}: ${Math.round(d.capacity)}% full, $${Math.round(d.atp)} avg ticket`}
                aria-pressed={active === d.slug}
                onClick={() => setActive(active === d.slug ? null : d.slug)}
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
              {labelled.has(d.slug) && (
                labelled.get(d.slug) === 'left'
                  ? <text x={d.x - d.r - 3} y={d.y + 4} fontSize="11" textAnchor="end" className="fill-gray-300 pointer-events-none">{d.label}</text>
                  : <text x={d.x + d.r + 3} y={d.y + 4} fontSize="11" className="fill-gray-300 pointer-events-none">{d.label}</text>
              )}
            </g>
          ))}
        </svg>
        </div>
        {sel && (
          <div className="absolute left-3 right-3 bottom-3 sm:left-auto sm:right-4 sm:w-72 bg-surface-elevated border border-white/10 rounded-lg px-3 py-2 text-sm text-white flex items-center justify-between gap-3" role="status">
            <span>
              <span className="font-semibold">{sel.title}</span>
              <span className="block text-xs text-gray-400">{Math.round(sel.capacity)}% full · ${Math.round(sel.atp)} avg ticket · {sel.seats.toLocaleString('en-US')} seats</span>
            </span>
            <button type="button" className="text-gray-400 hover:text-white min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0" aria-label="Close" onClick={() => setActive(null)}>✕</button>
          </div>
        )}
      </div>
      {unlabelled.length > 0 && (
        <p className="m-0 text-xs text-gray-400">Not labelled, to keep the busy spots readable: {unlabelled.join(', ')}. Hover, tab to or tap any dot for its name and numbers.</p>
      )}
    </div>
  );
}
