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
import { getMarketLabel } from '@/lib/browse-slugs';

interface Props {
  ranks: ShowRanks | null;
  market: ComputedShow['category'];
  className?: string;
}

export default function HeroRankLine({ ranks, market, className = '' }: Props) {
  if (!ranks) return null;
  const c = ranks.critic;
  if (!c.openMarket && !c.season && !c.allTime) return null;

  const label = getMarketLabel(market);
  const fragments: React.ReactNode[] = [];
  if (c.openMarket) {
    fragments.push(
      <span key="om">
        <span className="font-semibold text-gray-200">#{c.openMarket.rank}</span> of {c.openMarket.total} open {label}
      </span>,
    );
  }
  if (c.season) {
    fragments.push(
      <span key="se">
        <span className="font-semibold text-gray-200">#{c.season.rank}</span> this season
      </span>,
    );
  }
  if (c.allTime) {
    fragments.push(
      <span key="at" className="text-gray-500">
        #{c.allTime.rank} all-time<span className="text-gray-600">*</span>
      </span>,
    );
  }

  return (
    <p className={`text-[11px] sm:text-[12px] text-gray-400 mt-1 leading-snug ${className}`}>
      Ranks {fragments.map((f, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <span className="text-gray-600"> · </span> : null}
          {f}
        </React.Fragment>
      ))}
    </p>
  );
}
