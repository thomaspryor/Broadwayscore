import type { TierBadge } from '@/lib/awards-scoring';

interface AwardScoreBadgeProps {
  score: number;
  badge: TierBadge;
  inProgress: boolean;
  size?: 'md' | 'lg';
}

const TIER_COLOR_CLASS: Record<TierBadge, string> = {
  sweeper: 'score-must-see',
  decorated: 'score-great',
  honored: 'score-good',
  'in-the-hunt': 'score-good',
  nominated: 'score-tepid',
  eligible: 'score-none',
};

const TIER_LABEL: Record<TierBadge, string> = {
  sweeper: 'Sweeper',
  decorated: 'Decorated',
  honored: 'Honored',
  'in-the-hunt': 'In the Hunt',
  nominated: 'Nominated',
  eligible: 'Eligible',
};

export function AwardScoreBadge({ score, badge, inProgress, size = 'lg' }: AwardScoreBadgeProps) {
  const sizeClass = size === 'lg' ? 'score-badge-lg' : 'score-badge-md';
  const colorClass = score > 0 ? TIER_COLOR_CLASS[badge] : 'score-none';
  const label = inProgress && badge === 'nominated' ? 'In the Hunt' : TIER_LABEL[badge];

  return (
    <div className="relative inline-flex">
      <div className={`score-badge ${sizeClass} ${colorClass} font-bold relative`}>
        {score > 0 ? score : '—'}
        {inProgress && score > 0 && (
          <span
            aria-hidden
            className="absolute -top-1 -right-1 text-xs font-bold text-gray-400"
          >
            *
          </span>
        )}
      </div>
      <span className="sr-only">Award Score {score} — {label}</span>
    </div>
  );
}

export { TIER_LABEL as AWARD_TIER_LABEL };
