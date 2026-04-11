import Link from 'next/link';
import ShowImage from '@/components/ShowImage';
import { getOptimizedImageUrl } from '@/lib/images';
import type { ComputedShow } from '@/lib/engine';
import type { RawSocialPulse } from '@/lib/data-social-pulse';

/**
 * <TrendingShowCard> — single row on the /trending leaderboard.
 *
 * Server component. Renders a clickable row with rank number, show image,
 * title, tier label, volume, and positive-sentiment percentage. Score logic
 * and data loading happen upstream in `/trending/page.tsx`.
 */

interface TierStyle {
  label: string;
  emoji: string;
  textClass: string;
  bgClass: string;
  borderClass: string;
}

// Trimmed version of the card tier map — we only need label + color for a list row.
// Keep in sync with SocialPulseCard's TIER_DISPLAY if tiers are ever renamed.
const TIER_STYLES: Record<RawSocialPulse['tier'], TierStyle> = {
  Buzzing: {
    label: 'BUZZING',
    emoji: '🔥',
    textClass: 'text-orange-400',
    bgClass: 'bg-orange-500/10',
    borderClass: 'border-orange-500/40',
  },
  Rising: {
    label: 'RISING',
    emoji: '📈',
    textClass: 'text-emerald-400',
    bgClass: 'bg-emerald-500/10',
    borderClass: 'border-emerald-500/40',
  },
  Steady: {
    label: 'STEADY',
    emoji: '⚪',
    textClass: 'text-blue-400',
    bgClass: 'bg-blue-500/10',
    borderClass: 'border-blue-500/40',
  },
  Troubled: {
    label: 'TROUBLED',
    emoji: '💔',
    textClass: 'text-red-400',
    bgClass: 'bg-red-500/10',
    borderClass: 'border-red-500/40',
  },
  BuildingBaseline: {
    label: 'NEW',
    emoji: '✨',
    textClass: 'text-blue-400',
    bgClass: 'bg-blue-500/10',
    borderClass: 'border-blue-500/40',
  },
  Hidden: {
    label: '',
    emoji: '',
    textClass: 'text-gray-500',
    bgClass: 'bg-white/5',
    borderClass: 'border-white/10',
  },
};

function formatVolume(v: number): string {
  if (v >= 10000) return `${(v / 1000).toFixed(0)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return v.toLocaleString();
}

interface TrendingShowCardProps {
  rank: number; // 1-based display rank (not the market-wide rank)
  pulse: RawSocialPulse;
  show: ComputedShow | undefined;
}

export default function TrendingShowCard({ rank, pulse, show }: TrendingShowCardProps) {
  const style = TIER_STYLES[pulse.tier] || TIER_STYLES.Steady;
  const href = show?.slug ? `/show/${show.slug}` : null;
  const title = show?.title || pulse.showTitle;

  const posterCandidates = [
    getOptimizedImageUrl(show?.images?.poster, 'thumbnail'),
    getOptimizedImageUrl(show?.images?.hero, 'thumbnail'),
  ].filter(Boolean) as string[];

  // Rank color — gold for #1, silver for #2, bronze for #3, slate for the rest
  const rankColor =
    rank === 1
      ? { bg: '#f59e0b', text: '#1f2937' }
      : rank === 2
      ? { bg: '#cbd5e1', text: '#1f2937' }
      : rank === 3
      ? { bg: '#d97706', text: '#ffffff' }
      : { bg: '#374151', text: '#e5e7eb' };

  const row = (
    <div
      className={`card p-3 sm:p-4 flex items-center gap-3 sm:gap-4 border ${style.borderClass} ${style.bgClass} transition-transform hover:-translate-y-0.5`}
    >
      {/* Rank badge — the parent <ol> communicates ordering to AT, and the
          visible number is read naturally when focused, so we hide it from
          screen readers here to avoid double-announcing (aria-label + text). */}
      <div
        className="shrink-0 w-10 h-10 sm:w-12 sm:h-12 rounded-lg flex items-center justify-center font-extrabold text-lg sm:text-xl"
        style={{ backgroundColor: rankColor.bg, color: rankColor.text }}
        aria-hidden="true"
      >
        {rank}
      </div>

      {/* Show poster */}
      <div className="shrink-0 w-12 h-16 sm:w-14 sm:h-20 rounded-md overflow-hidden bg-white/5">
        <ShowImage
          sources={posterCandidates}
          alt={`${title} poster`}
          width={56}
          height={80}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          fallback={
            <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">
              {title.slice(0, 2).toUpperCase()}
            </div>
          }
        />
      </div>

      {/* Title + tier */}
      <div className="flex-1 min-w-0">
        <div
          className="text-white font-semibold truncate text-sm sm:text-base"
          title={title}
        >
          {title}
        </div>
        <div className="flex items-center gap-2 mt-1">
          <span className={`text-[10px] sm:text-xs font-bold tracking-wide ${style.textClass}`}>
            {style.label}
          </span>
          <span className="text-[10px] sm:text-xs" aria-hidden="true">
            {style.emoji}
          </span>
        </div>
      </div>

      {/* Stats */}
      <div className="shrink-0 text-right">
        <div className="text-sm sm:text-base font-bold text-white leading-none">
          {formatVolume(pulse.volume)}
        </div>
        <div className="text-[10px] sm:text-xs text-gray-500 mt-0.5 uppercase tracking-wide">
          mentions
        </div>
        <div className="text-[11px] sm:text-xs text-gray-400 mt-1">{pulse.positivePct}% positive</div>
      </div>
    </div>
  );

  if (!href) return row;

  return (
    <Link href={href} className="block no-underline">
      {row}
    </Link>
  );
}
