/**
 * Hero rank line — Variant B from the design mock.
 * Renders: "Ranks #N of M open {Market} · #N this season · #N all-time*"
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
  const fragments: React.ReactNode[] = [];
  if (c.openMarket) {
    fragments.push(
      <span key="om">
        <span className="font-bold text-brand">#{c.openMarket.rank}</span>
        {' '}of {c.openMarket.total} open {shortLabel} shows
      </span>,
    );
  }
  if (c.season) {
    fragments.push(
      <span key="se">
        <span className="font-bold text-brand">#{c.season.rank}</span>
        {' '}of {c.season.total} season openers
      </span>,
    );
  }
  if (c.allTime) {
    fragments.push(
      <span key="at">
        <span className="font-bold text-brand">#{c.allTime.rank}</span>
        {' '}of {c.allTime.total} all-time<span className="text-gray-600">*</span>
      </span>,
    );
  }

  return (
    <p className={`text-[12px] sm:text-[13px] text-gray-400 mt-1 leading-snug ${className}`}>
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
