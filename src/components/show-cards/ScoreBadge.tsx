// Score tier labels and tooltips
export const SCORE_TIERS = {
  mustSee: {
    label: 'Critical Gold',
    tooltip: 'Drop-everything great. If you\'re seeing one show, make it this.',
    range: '85-100',
    color: '#DAA520',
    glow: true,
  },
  recommended: {
    label: 'Recommended',
    tooltip: 'Strong choice—most people will have a great time.',
    range: '75-84',
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
    label: 'Skippable',
    tooltip: 'Optional. Fine to miss unless you\'re a completist or super fan.',
    range: '55-64',
    color: '#d97706',
    glow: false,
  },
  stayAway: {
    label: 'Stay Away',
    tooltip: 'Not recommended—save your time and money.',
    range: '<55',
    color: '#ef4444',
    glow: false,
  },
};

export type ScoreTier = typeof SCORE_TIERS.mustSee;

export function getScoreTier(score: number | null | undefined): ScoreTier | null {
  if (score === null || score === undefined) return null;
  const rounded = Math.round(score);
  if (rounded >= 85) return SCORE_TIERS.mustSee;
  if (rounded >= 75) return SCORE_TIERS.recommended;
  if (rounded >= 65) return SCORE_TIERS.worthSeeing;
  if (rounded >= 55) return SCORE_TIERS.skippable;
  return SCORE_TIERS.stayAway;
}

function MustSeeCrown({ size }: { size: 'sm' | 'md' | 'lg' | 'mini' }) {
  const dims = { mini: { w: 9, h: 6, top: -5 }, sm: { w: 10, h: 7, top: -6 }, md: { w: 13, h: 8, top: -7 }, lg: { w: 15, h: 9, top: -8 } }[size];
  return (
    <svg
      className="absolute left-1/2 -translate-x-1/2 z-10 pointer-events-none"
      style={{ top: dims.top, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' }}
      width={dims.w} height={dims.h} viewBox="0 0 20 12"
      aria-hidden="true"
    >
      <polygon points="1,11 3.5,3.5 7,7 10,1 13,7 16.5,3.5 19,11" fill="#FFD700" stroke="#B8860B" strokeWidth="0.8"/>
      <rect x="1" y="10" width="18" height="1.5" rx="0.5" fill="#DAA520"/>
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
}

export function ScoreBadge({ score, size = 'md', reviewCount, status, showCrown, category }: ScoreBadgeProps) {
  const sizeClass = {
    sm: 'w-11 h-11 text-lg rounded-lg',
    md: 'w-14 h-14 text-2xl rounded-xl',
    lg: 'w-16 h-16 sm:w-20 sm:h-20 text-3xl rounded-xl',
  }[size];

  // Show TBD for previews/upcoming shows
  if (status === 'previews' || status === 'upcoming') {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold text-gray-400`}>
        TBD
      </div>
    );
  }

  // Show TBD if fewer than minimum reviews (5 for Broadway, 3 for off-Broadway)
  const minReviews = category === 'off-broadway' ? 3 : 5;
  if (reviewCount !== undefined && reviewCount < minReviews) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold text-gray-400`}>
        TBD
      </div>
    );
  }

  if (score === undefined || score === null) {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold`}>
        —
      </div>
    );
  }

  const roundedScore = Math.round(score);
  let colorClass: string;
  let label: string;

  if (roundedScore >= 85) {
    colorClass = 'score-must-see';
    label = 'Critical Gold';
  } else if (roundedScore >= 75) {
    colorClass = 'score-great';
    label = 'Recommended';
  } else if (roundedScore >= 65) {
    colorClass = 'score-good';
    label = 'Worth Seeing';
  } else if (roundedScore >= 55) {
    colorClass = 'score-tepid';
    label = 'Mixed';
  } else {
    colorClass = 'score-skip';
    label = 'Skip';
  }

  const badge = (
    <div className={`score-badge ${sizeClass} ${colorClass} font-bold`}>
      {roundedScore}
    </div>
  );

  if (showCrown && roundedScore >= 85) {
    return (
      <div className="relative overflow-visible">
        <MustSeeCrown size={size} />
        {badge}
      </div>
    );
  }

  return badge;
}
