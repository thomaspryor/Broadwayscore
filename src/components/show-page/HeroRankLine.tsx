/**
 * Hero rank line — compact format.
 * Renders: "Ranks #N/M open {Market} · #N/M this season · #N/M all-time*"
 *
 * Mobile: stays on a single line, allows horizontal scroll if it overflows
 * (whitespace-nowrap + overflow-x-auto). User feedback 2026-05-19 — wrapping
 * to 2 lines on narrow viewports added too much vertical.
 *
 * Partial-null friendly: only renders the fragments that have data, so a
 * show with a valid market rank but a too-small season pool still gets a
 * useful line instead of being hidden entirely.
 *
 * Used by both the legacy hero (src/app/show/[slug]/page.tsx, RedesignOff
 * branch) and the redesigned hero (src/components/show-page/ShowHeroRedesign.tsx,
 * RedesignOn branch). Sharing this component keeps the rank line identical
 * across both code paths so flipping the redesign flag doesn't change the
 * rank line's appearance.
 */
import React from 'react';
import type { ComputedShow } from '@/lib/data-types';
import type { ShowRanks } from '@/lib/data-show-ranks';
interface Props {
  ranks: ShowRanks | null;
  market: ComputedShow['category'];
  className?: string;
  /** Which metric's ranks to render. Defaults to 'critic' for backwards
   *  compatibility with existing critic-side callers (hero + legacy header). */
  metric?: 'critic' | 'audience';
}

export default function HeroRankLine({ ranks, market, className = '', metric = 'critic' }: Props) {
  if (!ranks) return null;
  const c = ranks[metric];
  if (!c || (!c.openMarket && !c.season && !c.allTime)) return null;

  const shortLabel = getShortMarketLabel(market);
  // OB/OWE have no reliable historical coverage, so an all-time rank there is
  // misleading — drop the all-time fragment (matches WhereItRanks hiding the
  // all-time column for these markets).
  const hideAllTime = market === 'off-broadway' || market === 'off-west-end';
  const fragments: React.ReactNode[] = [];
  if (c.openMarket && c.openMarket.total > 0) {
    fragments.push(
      <span key="om">
        <span className="font-bold text-brand">#{c.openMarket.rank}/{c.openMarket.total}</span>
        {' '}open {shortLabel}
      </span>,
    );
  }
  if (c.season && c.season.total > 0) {
    fragments.push(
      <span key="se">
        <span className="font-bold text-brand">#{c.season.rank}/{c.season.total}</span>
        {' '}this season
      </span>,
    );
  }
  if (!hideAllTime && c.allTime && c.allTime.total > 0) {
    fragments.push(
      <span key="at">
        <span className="font-bold text-brand">#{c.allTime.rank}/{c.allTime.total}</span>
        {' '}all-time<span className="text-gray-600">*</span>
      </span>,
    );
  }
  if (fragments.length === 0) return null;

  return (
    <p className={`text-[12px] sm:text-[13px] text-gray-400 mt-1 leading-snug whitespace-nowrap overflow-x-auto scrollbar-hide ${className}`}>
      Ranks {fragments.map((f, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span className="text-gray-600"> · </span> : null}
          {f}
        </React.Fragment>
      ))}
    </p>
  );
}

/** Short market label for the hero rank line ("BW", "WE", "OB", "OWE"). */
function getShortMarketLabel(category: ComputedShow['category']): string {
  switch (category) {
    case 'broadway': return 'BW';
    case 'west-end': return 'WE';
    case 'off-broadway': return 'OB';
    case 'off-west-end': return 'OWE';
    default: return 'BW';
  }
}
