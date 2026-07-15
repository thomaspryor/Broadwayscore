import { getMarketMinReviews } from '@/lib/market-utils';
import { getGoldThreshold, isCriticalGold } from '@/config/score-buckets';

// Score tier labels and tooltips
export const SCORE_TIERS = {
  mustSee: {
    label: 'Critical Gold',
    tooltip: 'Drop-everything great. If you\'re seeing one show, make it this.',
    range: '83-100',
    color: '#FFD700',
    glow: true,
  },
  recommended: {
    label: 'Recommended',
    tooltip: 'Strong choice—most people will have a great time.',
    range: '75-82',
    color: '#22c55e',
    glow: false,
  },
  worthSeeing: {
    label: 'Worth Seeing',
    tooltip: 'Good, with caveats. Best if the premise/cast/genre is your thing.',
    range: '65-74',
    color: '#14b8a6',
    glow: false,
  },
  skippable: {
    label: 'Mixed',
    tooltip: 'Critics are split — worth a look if the premise grabs you.',
    range: '55-64',
    color: '#d97706',
    glow: false,
  },
  stayAway: {
    label: 'Critical Miss',
    tooltip: 'Not recommended—save your time and money.',
    range: '<55',
    color: '#ef4444',
    glow: false,
  },
};

export type ScoreTier = typeof SCORE_TIERS.mustSee;

export function getScoreTier(score: number | null | undefined, category?: string): ScoreTier | null {
  if (score === null || score === undefined) return null;
  const rounded = Math.round(score);
  if (rounded >= getGoldThreshold(category)) return SCORE_TIERS.mustSee;
  if (rounded >= 75) return SCORE_TIERS.recommended;
  if (rounded >= 65) return SCORE_TIERS.worthSeeing;
  if (rounded >= 55) return SCORE_TIERS.skippable;
  return SCORE_TIERS.stayAway;
}

const TIER_COLOR_CLASS: Record<string, string> = {
  'Critical Gold': 'score-must-see',
  'Recommended': 'score-great',
  'Worth Seeing': 'score-good',
  'Mixed': 'score-tepid',
  'Critical Miss': 'score-skip',
};

const TIER_TEXT_CLASS: Record<string, string> = {
  'Critical Gold': 'text-score-must-see',
  'Recommended': 'text-score-great',
  'Worth Seeing': 'text-score-good',
  'Mixed': 'text-score-tepid',
  'Critical Miss': 'text-score-skip',
};

export function getScoreColorClass(score: number, category?: string): string {
  const tier = getScoreTier(score, category);
  return tier ? TIER_COLOR_CLASS[tier.label] ?? 'score-skip' : 'score-skip';
}

export function getScoreTextColorClass(score: number, category?: string): string {
  const tier = getScoreTier(score, category);
  return tier ? TIER_TEXT_CLASS[tier.label] ?? 'text-score-skip' : 'text-score-skip';
}

function MustSeeCrown({ size }: { size: 'sm' | 'md' | 'lg' | 'mini' }) {
  // Simple flat crown matching native app — centered on top, no outline/base band
  const dims = { mini: { w: 9, h: 5, top: -4 }, sm: { w: 10, h: 5, top: -4 }, md: { w: 13, h: 6, top: -5 }, lg: { w: 15, h: 7, top: -6 } }[size];
  return (
    <svg
      className="absolute left-1/2 -translate-x-1/2 z-10 pointer-events-none"
      style={{ top: dims.top }}
      width={dims.w} height={dims.h} viewBox="0 0 24 14"
      aria-hidden="true"
    >
      <path d="M2,13 L5,5 L9,8 L12,1 L15,8 L19,5 L22,13 Z" fill="#FFD700" opacity="0.85"/>
    </svg>
  );
}

export { MustSeeCrown };

export interface ScoreBadgeProps {
  score?: number | null;
  size?: 'sm' | 'md' | 'lg';
  reviewCount?: number;
  status?: string;
  showCrown?: boolean;
  category?: string;
  tier1And2Count?: number;
  /** Render a "Not Yet Rated" caption under TBD badges — for pages (guides)
   *  that don't already label the badge the way ShowListCard does. */
  labelTbd?: boolean;
}

function TbdBadge({ sizeClass, labelTbd, caption }: { sizeClass: string; labelTbd?: boolean; caption: string }) {
  const badge = (
    <div className={`score-badge ${sizeClass} score-none font-bold text-gray-400`} title={caption}>
      TBD
    </div>
  );
  if (!labelTbd) return badge;
  return (
    <div className="flex flex-col items-center gap-1">
      {badge}
      <span className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap text-gray-500">
        Not Yet Rated
      </span>
    </div>
  );
}

export function ScoreBadge({ score, size = 'md', reviewCount, status, showCrown, category, tier1And2Count, labelTbd }: ScoreBadgeProps) {
  const sizeClass = {
    sm: 'w-11 h-11 text-lg lg:w-[68px] lg:h-[68px] lg:text-3xl rounded-lg',
    md: 'w-14 h-14 text-2xl lg:w-[68px] lg:h-[68px] lg:text-3xl rounded-xl',
    lg: 'w-16 h-16 sm:w-20 sm:h-20 text-3xl rounded-xl',
  }[size];

  // Show TBD for previews/upcoming shows
  if (status === 'previews' || status === 'upcoming') {
    return <TbdBadge sizeClass={sizeClass} labelTbd={labelTbd} caption="Score arrives once critics review this show after opening night" />;
  }

  // Show TBD if fewer than minimum reviews (5 for Broadway, 3 for off-Broadway/London; +2 if all T3)
  let minReviews = getMarketMinReviews(category);
  if (tier1And2Count !== undefined && tier1And2Count === 0) minReviews += 2;
  if (reviewCount !== undefined && reviewCount < minReviews) {
    return <TbdBadge sizeClass={sizeClass} labelTbd={labelTbd} caption="Not enough critic reviews yet to calculate a score" />;
  }

  if (score === undefined || score === null) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold`}>
        —
      </div>
    );
  }

  const roundedScore = Math.round(score);
  const colorClass = getScoreColorClass(roundedScore, category);
  const tier = getScoreTier(roundedScore, category);
  const label = tier?.label ?? 'Critical Miss';

  const badge = (
    <div className={`score-badge ${sizeClass} ${colorClass} font-bold`}>
      {roundedScore}
    </div>
  );

  if (showCrown && isCriticalGold(roundedScore, category)) {
    return (
      <div className="relative overflow-visible">
        <MustSeeCrown size={size} />
        {badge}
      </div>
    );
  }

  return badge;
}
