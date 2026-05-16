import type { TierBadge } from '@/lib/awards-scoring';

interface AwardScoreBadgeProps {
  score: number;
  badge: TierBadge;
  inProgress: boolean;
  size?: 'md' | 'lg';
}

// Tier ramp: monotonically intensifies (neutral → faint warm → warm → cool
// achievement → richer green → top gold). Cool greens are reserved for the
// "won something" tiers so they don't get out-shouted by warm pre-results
// amber. Keep the amber/emerald/teal palette already used elsewhere on the
// awards surface.
const TIER_STYLES: Record<TierBadge, { bg: string; text: string }> = {
  sweeper:       { bg: 'bg-amber-500',     text: 'text-amber-950' },
  decorated:     { bg: 'bg-emerald-500',   text: 'text-white' },
  honored:       { bg: 'bg-teal-600',      text: 'text-white' },
  'in-the-hunt': { bg: 'bg-amber-700/70',  text: 'text-amber-50' },
  nominated:     { bg: 'bg-amber-900/40',  text: 'text-amber-100' },
  eligible:      { bg: 'bg-white/10',      text: 'text-gray-400' },
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
  const styles = score > 0 ? TIER_STYLES[badge] : TIER_STYLES.eligible;
  const label = inProgress && badge === 'nominated' ? 'In the Hunt' : TIER_LABEL[badge];

  const sizeBox = size === 'lg' ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-14 h-14';
  const sizeText = size === 'lg' ? 'text-3xl' : 'text-2xl';

  return (
    <div
      className={`${sizeBox} ${styles.bg} ${styles.text} rounded-xl flex items-center justify-center font-bold ${sizeText} shadow-sm`}
      aria-label={`Award Score ${score} — ${label}`}
    >
      {score > 0 ? score : '—'}
    </div>
  );
}

export { TIER_LABEL as AWARD_TIER_LABEL };
