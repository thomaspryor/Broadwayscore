import Link from 'next/link';
import ShowImage from '@/components/ShowImage';
import { getOptimizedImageUrl } from '@/lib/images';
import type { ComputedShow } from '@/lib/engine';
import type { RawSocialPulse } from '@/lib/data-social-pulse';

/**
 * <TrendingShowCard> — single row on the /trending leaderboard.
 *
 * Follows the ShowListCard compact-variant pattern:
 *   - Round `RankBadge` circles (gold top-3, neutral 4+) — same as browse pages
 *   - Standard `card` + `hover:bg-surface-raised/80` — no tier-colored borders
 *   - Thumbnail at poster ratio matching MiniShowCard
 *   - Tier label as a small inline pill, not a row-wrapping border
 *   - Stats column in the same ~w-20/w-24 zone as score badges
 *
 * Server component. Score logic and data loading happen upstream.
 */

// ---------- Tier display (label + color only) ----------
// Keep in sync with SocialPulseCard's TIER_DISPLAY.
const TIER_LABEL: Record<string, { label: string; color: string }> = {
  Buzzing:          { label: 'Buzzing',  color: '#f97316' }, // orange-500
  Rising:           { label: 'Rising',   color: '#10b981' }, // emerald-500
  Steady:           { label: 'Steady',   color: '#3b82f6' }, // blue-500
  Troubled:         { label: 'Troubled', color: '#ef4444' }, // red-500
  BuildingBaseline: { label: 'Steady',   color: '#3b82f6' }, // matches show-page card
};

function formatVolume(v: number): string {
  if (v >= 10000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString();
}

// ---------- RankBadge — reuses the exact ShowListCard pattern ----------
// Round circle, gold for top 3, neutral for 4+.
// Matches ShowListCard.tsx:39-48 so the visual language is identical
// to ranked browse pages.
function RankBadge({ rank }: { rank: number }) {
  const isTop3 = rank <= 3;
  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0 ${
        isTop3
          ? 'bg-accent-gold text-gray-900'
          : 'bg-surface-overlay text-gray-400 border border-white/10'
      }`}
      aria-hidden="true"
    >
      {rank}
    </div>
  );
}

interface TrendingShowCardProps {
  rank: number;
  pulse: RawSocialPulse;
  show: ComputedShow | undefined;
}

export default function TrendingShowCard({ rank, pulse, show }: TrendingShowCardProps) {
  const tier = TIER_LABEL[pulse.tier] || TIER_LABEL.Steady;
  const href = show?.slug ? `/show/${show.slug}` : null;
  const title = show?.title || pulse.showTitle;

  const posterCandidates = [
    getOptimizedImageUrl(show?.images?.poster, 'thumbnail'),
    getOptimizedImageUrl(show?.images?.thumbnail, 'thumbnail'),
    getOptimizedImageUrl(show?.images?.hero, 'thumbnail'),
  ].filter(Boolean) as string[];

  const card = (
    <div className="flex items-center gap-3">
      {/* Rank circle (hidden on mobile, mirroring ShowListCard compact+rank variant) */}
      <div className="hidden sm:block">
        <RankBadge rank={rank} />
      </div>

      {/* Card row — standard card styling, hover treatment matches ShowListCard */}
      <div className="card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 hover:bg-surface-raised/80 transition-colors group flex-1 min-w-0">
        {/* Mobile rank (visible < sm since the circle is hidden) */}
        <span
          className="sm:hidden shrink-0 w-6 text-center text-sm font-bold text-gray-500"
          aria-hidden="true"
        >
          {rank}
        </span>

        {/* Show poster — poster ratio like MiniShowCard */}
        <div className="shrink-0 w-12 h-16 sm:w-14 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay">
          <ShowImage
            sources={posterCandidates}
            alt={`${title} poster`}
            width={56}
            height={80}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            fallback={
              <div className="w-full h-full flex items-center justify-center text-gray-500" aria-hidden="true">
                <span className="text-2xl">🎭</span>
              </div>
            }
          />
        </div>

        {/* Title + tier pill */}
        <div className="flex-1 min-w-0">
          <div
            className="font-bold text-white text-sm sm:text-base group-hover:text-brand transition-colors line-clamp-2"
            title={title}
          >
            {title}
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span
              className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded"
              style={{ color: tier.color, backgroundColor: `${tier.color}15` }}
            >
              {tier.label}
            </span>
            <span className="text-[10px] text-gray-500">
              {formatVolume(pulse.volume)} mentions
            </span>
          </div>
        </div>

        {/* Stats column — same w-20/w-24 zone as score badges on ShowListCard */}
        <div className="shrink-0 flex flex-col items-center justify-center w-16 sm:w-20">
          <div className="text-lg sm:text-xl font-bold text-white leading-none">
            {pulse.positivePct}%
          </div>
          <div className="text-[9px] font-semibold uppercase tracking-wide text-gray-500 mt-0.5">
            positive
          </div>
        </div>
      </div>
    </div>
  );

  if (!href) return card;

  return (
    <Link href={href} className="block no-underline">
      {card}
    </Link>
  );
}
