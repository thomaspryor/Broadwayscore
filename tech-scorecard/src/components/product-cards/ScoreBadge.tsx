import { getScoreTier } from '@/config/score-buckets';

const SIZE = {
  sm: 'w-11 h-11 text-lg rounded-lg',
  md: 'w-14 h-14 text-2xl lg:w-[68px] lg:h-[68px] lg:text-3xl rounded-xl',
  lg: 'w-16 h-16 sm:w-20 sm:h-20 text-3xl sm:text-4xl rounded-xl',
  review: 'w-12 h-12 text-lg rounded-lg',
} as const;

export function ScoreBadge({ score, size = 'md' }: { score: number | null; size?: keyof typeof SIZE }) {
  if (score == null) {
    return <div className={`score-badge score-none ${SIZE[size]}`} title="Not enough critic reviews yet">TBD</div>;
  }
  const rounded = Math.round(score);
  const tier = getScoreTier(rounded);
  return (
    <div className={`score-badge ${tier.badgeClass} ${SIZE[size]}`} role="img" title={tier.label} aria-label={`Score ${rounded}, ${tier.label}`}>
      {rounded}
    </div>
  );
}
