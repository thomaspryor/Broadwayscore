import type { TierBadge } from '@/lib/awards-scoring';
import { TrophyIcon } from '@/components/icons';

interface AwardScoreBadgeProps {
  score: number;
  badge: TierBadge;
  inProgress: boolean;
  size?: 'md' | 'lg';
}

/**
 * Award Score badge — its own visual identity, not a copy of the critic
 * ScoreBadge. Same square/rounded-xl rhythm so it belongs in the design
 * system, but solid tier colors (not the metallic must-see gradient) and a
 * small trophy icon in the corner mark it as award-related, not critic.
 */

const TIER_STYLES: Record<TierBadge, { bg: string; text: string; trophy: string }> = {
  sweeper:       { bg: 'bg-amber-500',    text: 'text-amber-950', trophy: 'text-amber-900/70' },
  decorated:     { bg: 'bg-emerald-600',  text: 'text-white',     trophy: 'text-emerald-100/70' },
  honored:       { bg: 'bg-teal-600',     text: 'text-white',     trophy: 'text-teal-100/70' },
  'in-the-hunt': { bg: 'bg-amber-700/80', text: 'text-amber-50',  trophy: 'text-amber-100/60' },
  nominated:     { bg: 'bg-amber-700/80', text: 'text-amber-50',  trophy: 'text-amber-100/60' },
  eligible:      { bg: 'bg-white/10',     text: 'text-gray-400',  trophy: 'text-gray-500/70' },
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
  const sizeTrophy = size === 'lg' ? 'w-3.5 h-3.5' : 'w-3 h-3';

  return (
    <div
      className={`relative ${sizeBox} ${styles.bg} ${styles.text} rounded-xl flex items-center justify-center font-bold ${sizeText} shadow-sm`}
      aria-label={`Award Score ${score} — ${label}`}
    >
      {score > 0 ? score : '—'}
      {score > 0 && (
        <TrophyIcon className={`absolute bottom-1.5 right-1.5 ${sizeTrophy} ${styles.trophy}`} />
      )}
      {inProgress && score > 0 && (
        <span aria-hidden className={`absolute -top-1 -right-1 text-xs font-bold ${styles.text}`}>*</span>
      )}
    </div>
  );
}

export { TIER_LABEL as AWARD_TIER_LABEL };
