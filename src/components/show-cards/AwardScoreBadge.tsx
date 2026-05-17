import type { TierBadge } from '@/lib/awards-scoring';

interface AwardScoreBadgeProps {
  score: number;
  badge: TierBadge;
  inProgress: boolean;
  size?: 'md' | 'lg';
}

// Tier ramp: monotonically intensifies (neutral → faint warm → warm → cool
// achievement → richer green → top gold). Glow shadow matches tier color so
// the badge feels in-family with the critic ScoreBadge (.score-great etc.),
// which uses `box-shadow: 0 2px 8px rgba(<tier-color>, 0.3)`.
const TIER_STYLES: Record<TierBadge, { bg: string; text: string; label: string; glow: string }> = {
  sweeper:       { bg: 'bg-amber-500',     text: 'text-amber-950', label: 'text-amber-400',   glow: '0 2px 8px rgba(245, 158, 11, 0.35), 0 0 18px rgba(245, 158, 11, 0.22)' },
  decorated:     { bg: 'bg-emerald-500',   text: 'text-white',     label: 'text-emerald-400', glow: '0 2px 8px rgba(16, 185, 129, 0.35)' },
  honored:       { bg: 'bg-teal-600',      text: 'text-white',     label: 'text-teal-400',    glow: '0 2px 8px rgba(13, 148, 136, 0.35)' },
  'in-the-hunt': { bg: 'bg-amber-700/70',  text: 'text-amber-50',  label: 'text-amber-300',   glow: '0 2px 8px rgba(180, 83, 9, 0.28)' },
  nominated:     { bg: 'bg-amber-900/40',  text: 'text-amber-100', label: 'text-amber-200',   glow: '0 2px 6px rgba(120, 53, 15, 0.22)' },
  eligible:      { bg: 'bg-white/10',      text: 'text-gray-400',  label: 'text-gray-400',    glow: '0 2px 4px rgba(0, 0, 0, 0.25)' },
};

const TIER_LABEL: Record<TierBadge, string> = {
  sweeper: 'Sweeper',
  decorated: 'Decorated',
  honored: 'Honored',
  'in-the-hunt': 'In the Hunt',
  nominated: 'Nominated',
  eligible: 'Eligible',
};

export function getAwardTierLabelClass(badge: TierBadge, score: number): string {
  return score > 0 ? TIER_STYLES[badge].label : TIER_STYLES.eligible.label;
}

export function AwardScoreBadge({ score, badge, inProgress, size = 'lg' }: AwardScoreBadgeProps) {
  const styles = score > 0 ? TIER_STYLES[badge] : TIER_STYLES.eligible;
  const label = inProgress && badge === 'nominated' ? 'In the Hunt' : TIER_LABEL[badge];

  const sizeBox = size === 'lg' ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-14 h-14';
  const sizeText = size === 'lg' ? 'text-3xl' : 'text-2xl';

  return (
    <div
      className={`${sizeBox} ${styles.bg} ${styles.text} rounded-xl flex items-center justify-center font-bold ${sizeText} relative`}
      style={{ boxShadow: styles.glow }}
      aria-label={inProgress && score > 0 ? `Provisional Award Score ${score} — ${label}` : `Award Score ${score} — ${label}`}
    >
      <span className="flex items-start gap-0.5 leading-none">
        <span>{score > 0 ? score : '—'}</span>
        {inProgress && score > 0 && (
          <span aria-hidden className="text-base align-super animate-pulse" style={{ marginTop: '-0.15em' }}>*</span>
        )}
      </span>
    </div>
  );
}

export { TIER_LABEL as AWARD_TIER_LABEL };
