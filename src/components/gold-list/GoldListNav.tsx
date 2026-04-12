/**
 * GoldListNav — Market tabs → Venue tier toggle → List type pills
 *
 * Hierarchy: New York / London → Broadway / Off-Broadway → Critical / Audience / etc.
 * Each combination links to its own URL (no client state).
 */

import Link from 'next/link';
import {
  GOLD_LIST_MAP,
  getMarketForListType,
  getVenueTiersForMarket,
  getVenueTierForListType,
  getListTypesForVenueTier,
  getDefaultListTypeForVenueTier,
  venueTierLabel,
  marketLabel,
} from '@/config/gold-lists';
import type { GoldListType, GoldListMarket, VenueTier } from '@/config/gold-lists';
import { GoldListBadge } from './GoldListBadge';

/** Pill label for list type — strips market prefix, shows the *kind* of list. */
function pillLabel(lt: GoldListType): string {
  if (lt.startsWith('critical-gold')) return 'Critics';
  if (lt.startsWith('audience-gold')) return 'Audiences';
  if (lt === 'box-office-gold') return 'Box Office';
  if (lt === 'hot-ticket-gold') return 'Hot Tickets';
  return GOLD_LIST_MAP[lt].shortTitle;
}

interface GoldListNavProps {
  /** Currently active list type */
  currentListType: GoldListType;
  /** Season slug ('2024-2025') or 'all-time' — used for building links */
  seasonSlug: string;
}

export function GoldListNav({ currentListType, seasonSlug }: GoldListNavProps) {
  const currentMarket = getMarketForListType(currentListType);
  const currentTier = getVenueTierForListType(currentListType);
  const tiers = getVenueTiersForMarket(currentMarket);
  const listTypes = getListTypesForVenueTier(currentTier);

  const markets: GoldListMarket[] = ['new-york', 'london'];

  function listUrl(listType: GoldListType): string {
    return `/lists/${listType}/${seasonSlug}`;
  }

  /** When switching market, land on the default list for that market's primary tier. */
  function marketUrl(market: GoldListMarket): string {
    const tier = getVenueTiersForMarket(market)[0];
    return listUrl(getDefaultListTypeForVenueTier(tier));
  }

  /** When switching venue tier, land on the default list for that tier. */
  function tierUrl(tier: VenueTier): string {
    return listUrl(getDefaultListTypeForVenueTier(tier));
  }

  return (
    <nav className="mb-6 space-y-3" aria-label="Gold List navigation">
      {/* Row 1: Market tabs */}
      <div className="flex gap-1">
        {markets.map(market => (
          <Link
            key={market}
            href={market === currentMarket ? '#' : marketUrl(market)}
            aria-current={market === currentMarket ? 'true' : undefined}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
              market === currentMarket
                ? 'bg-white/10 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            {marketLabel(market)}
          </Link>
        ))}
      </div>

      {/* Row 2: Venue tier toggle */}
      <div className="flex gap-1">
        {tiers.map(tier => (
          <Link
            key={tier}
            href={tier === currentTier ? '#' : tierUrl(tier)}
            aria-current={tier === currentTier ? 'true' : undefined}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              tier === currentTier
                ? 'bg-brand/15 text-brand border border-brand/30'
                : 'text-gray-400 hover:text-gray-300 hover:bg-white/5'
            }`}
          >
            {venueTierLabel(tier)}
          </Link>
        ))}
      </div>

      {/* Row 3: List type pills — only shown when tier has multiple list types */}
      {listTypes.length > 1 && (
        <div className="flex gap-1 flex-wrap">
          {listTypes.map(lt => {
            const c = GOLD_LIST_MAP[lt];
            const isActive = lt === currentListType;
            return (
              <Link
                key={lt}
                href={isActive ? '#' : listUrl(lt)}
                aria-current={isActive ? 'true' : undefined}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? `${c.bgClass} ${c.color} border ${c.borderClass}`
                    : 'text-gray-400 hover:text-gray-300 hover:bg-white/5'
                }`}
              >
                <GoldListBadge type={lt} size="sm" />
                {pillLabel(lt)}
              </Link>
            );
          })}
        </div>
      )}
    </nav>
  );
}
