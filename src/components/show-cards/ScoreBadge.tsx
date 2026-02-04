// Score tier labels and tooltips
export const SCORE_TIERS = {
  mustSee: {
    label: 'Must-See',
    tooltip: 'Drop-everything great. If you\'re seeing one show, make it this.',
    range: '85-100',
    color: '#FFD700',
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
    color: '#f59e0b',
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

export interface ScoreBadgeProps {
  score?: number | null;
  size?: 'sm' | 'md' | 'lg';
  reviewCount?: number;
  status?: string;
}

export function ScoreBadge({ score, size = 'md', reviewCount, status }: ScoreBadgeProps) {
  const sizeClass = {
    sm: 'w-11 h-11 text-lg rounded-lg',
    md: 'w-14 h-14 text-2xl rounded-xl',
    lg: 'w-16 h-16 sm:w-20 sm:h-20 text-3xl rounded-xl',
  }[size];

  // Show TBD for previews shows
  if (status === 'previews') {
    return (
      <div className={`score-badge ${sizeClass} score-none font-bold text-gray-400`}>
        TBD
      </div>
    );
  }

  // Show TBD if fewer than 5 reviews
  if (reviewCount !== undefined && reviewCount < 5) {
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
    label = 'Must-See';
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

  return (
    <div className={`score-badge ${sizeClass} ${colorClass} font-bold`}>
      {roundedScore}
    </div>
  );
}
