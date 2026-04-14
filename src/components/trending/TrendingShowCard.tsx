import Link from 'next/link';
import ShowImage from '@/components/ShowImage';
import { getOptimizedImageUrl } from '@/lib/images';
import type { ComputedShow } from '@/lib/engine';
import type { RawSocialPulse } from '@/lib/data-social-pulse';

/**
 * <TrendingShowCard> — single row on the /trending leaderboard.
 *
 * Layout C: rank badge outside (SocialPulseCard style), poster + title + tier
 * + sentiment bar in the center, volume column right-aligned (like the
 * ScoreBadge column on ShowListCard).
 *
 * Server component. Data loading happens upstream in page.tsx.
 */

// ---------- Tier display ----------
const TIER_LABEL: Record<string, { label: string; emoji: string; color: string }> = {
  Buzzing:          { label: 'BUZZING',  emoji: '🔥', color: '#f97316' },
  Rising:           { label: 'RISING',   emoji: '📈', color: '#10b981' },
  Steady:           { label: 'STEADY',   emoji: '⚪', color: '#3b82f6' },
  Troubled:         { label: 'TROUBLED', emoji: '💔', color: '#ef4444' },
  BuildingBaseline: { label: 'STEADY',   emoji: '⚪', color: '#3b82f6' },
};

function formatVolume(v: number): string {
  if (v >= 10000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString();
}

// Rank badge uses the tier color so rank + tier reinforce each other visually.
const TIER_BADGE_COLOR: Record<string, { bg: string; text: string }> = {
  Buzzing:          { bg: '#f97316', text: '#ffffff' }, // orange
  Rising:           { bg: '#10b981', text: '#ffffff' }, // emerald
  Steady:           { bg: '#3b82f6', text: '#ffffff' }, // blue
  Troubled:         { bg: '#ef4444', text: '#ffffff' }, // red
  BuildingBaseline: { bg: '#3b82f6', text: '#ffffff' }, // blue (same as Steady)
};

interface TrendingShowCardProps {
  rank: number;
  pulse: RawSocialPulse;
  show: ComputedShow | undefined;
}

export default function TrendingShowCard({ rank, pulse, show }: TrendingShowCardProps) {
  const tier = TIER_LABEL[pulse.tier] || TIER_LABEL.Steady;
  const href = show?.slug ? `/show/${show.slug}` : null;
  const title = show?.title || pulse.showTitle;
  const rankData = pulse.rank;
  const position = rankData?.position ?? rank;
  const total = rankData?.total ?? 0;
  const rankColors = TIER_BADGE_COLOR[pulse.tier] || { bg: '#475569', text: '#cbd5e1' };

  const posterCandidates = [
    getOptimizedImageUrl(show?.images?.poster, 'thumbnail'),
    getOptimizedImageUrl(show?.images?.thumbnail, 'thumbnail'),
    getOptimizedImageUrl(show?.images?.hero, 'thumbnail'),
  ].filter(Boolean) as string[];

  // Sentiment bar — same gradient as SocialPulseCard
  const posBarWidth = Math.max(0, Math.min(100, pulse.positivePct));
  const sentimentBarStyle = {
    width: `${posBarWidth}%`,
    background: 'linear-gradient(90deg, #6366f1 0%, #3b82f6 50%, #10b981 100%)',
    backgroundSize: `${(100 / Math.max(posBarWidth, 1)) * 100}% 100%`,
  };

  const card = (
    <div className="flex items-center gap-2 sm:gap-3">
      {/* Rank badge — compact, poster is the visual star */}
      <div
        className="shrink-0 flex flex-col items-center justify-center rounded-lg w-10 sm:w-12 h-12 sm:h-14 shadow-sm"
        style={{
          backgroundColor: rankColors.bg,
          color: rankColors.text,
          boxShadow: `0 2px 8px ${rankColors.bg}30`,
        }}
        aria-label={`Ranked #${position} of ${total}`}
      >
        <div className="text-base sm:text-lg font-extrabold leading-none">#{position}</div>
        {total > 0 && (
          <div className="text-[8px] sm:text-[9px] font-medium opacity-85 mt-0.5">of {total}</div>
        )}
      </div>

      {/* Card body */}
      <div className="card flex-1 min-w-0 hover:bg-surface-raised/80 transition-colors group">
        <div className="flex items-center gap-3 sm:gap-4 p-3 sm:p-4">
          {/* Poster */}
          <div className="shrink-0 w-11 h-[60px] sm:w-14 sm:h-20 rounded-lg overflow-hidden bg-surface-overlay">
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
                  <span className="text-xl">🎭</span>
                </div>
              }
            />
          </div>

          {/* Center: title + tier + bar */}
          <div className="flex-1 min-w-0">
            <div
              className="font-bold text-white text-sm sm:text-base group-hover:text-brand transition-colors line-clamp-1"
              title={title}
            >
              {title}
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] sm:text-[10px] font-bold uppercase tracking-wider rounded"
                style={{ color: tier.color, backgroundColor: `${tier.color}15` }}
              >
                {tier.label} <span aria-hidden="true">{tier.emoji}</span>
              </span>
            </div>
            {/* Sentiment bar */}
            <div className="mt-2">
              <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={sentimentBarStyle} />
              </div>
              <div className="text-[10px] text-gray-500 mt-1">{pulse.positivePct}% positive</div>
            </div>
          </div>

          {/* Right column: volume (like ScoreBadge placement) */}
          <div className="shrink-0 flex flex-col items-center justify-center w-14 sm:w-20">
            <div className="text-lg sm:text-xl font-bold text-white leading-none">
              {formatVolume(pulse.volume)}
            </div>
            <div className="text-[8px] sm:text-[9px] font-semibold uppercase tracking-wide text-gray-500 mt-0.5">
              mentions
            </div>
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
