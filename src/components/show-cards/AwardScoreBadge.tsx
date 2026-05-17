import type { TierBadge } from '@/lib/awards-scoring';

interface AwardScoreBadgeProps {
  score: number;
  badge: TierBadge;
  inProgress: boolean;
  size?: 'md' | 'lg';
}

// Color palette aligned with the critic ScoreBadge (2026-05-17): the three
// "winning" award tiers reuse the critic-positive CSS classes so a 100
// Sweeper and a 91 Critical Gold share the same gold-metallic shimmer, an
// 82 Decorated matches a Recommended-78 emerald, and a 58 Honored matches
// a Worth Seeing-71 teal. Unwon tiers stay in their own warm/neutral
// family (they don't map onto the critic Skippable/Stay-Away tiers — those
// signal "bad," award unwon tiers signal "recognized but didn't win").
//
// Each tier provides ONE of:
//   - `criticClass`: CSS class to apply (uses globals.css critic styles —
//     .score-must-see / .score-great / .score-good — full polish for free)
//   - `bg` + optional `glow`: standalone Tailwind background + box-shadow
//
// `label` is the tier-name text color used by the surrounding card.
interface TierStyle {
  criticClass?: string;
  bg?: string;
  text: string;
  label: string;
  glow?: string;
}

const TIER_STYLES: Record<TierBadge, TierStyle> = {
  // Winning tiers — reuse critic-positive CSS classes for visual lockstep.
  sweeper:       { criticClass: 'score-must-see', text: '',          label: 'text-amber-400' },
  decorated:     { criticClass: 'score-great',    text: '',          label: 'text-emerald-400' },
  honored:       { criticClass: 'score-good',     text: '',          label: 'text-teal-400' },
  // Unwon tiers — muted warm so they don't compete with critic-positive tiers.
  'in-the-hunt': { bg: 'bg-amber-600/40 border border-amber-500/30', text: 'text-amber-100', label: 'text-amber-300', glow: '0 2px 6px rgba(217, 119, 6, 0.25)' },
  nominated:     { bg: 'bg-surface-overlay border border-amber-500/20', text: 'text-amber-200', label: 'text-amber-200' },
  eligible:      { bg: 'bg-white/10', text: 'text-gray-400', label: 'text-gray-400' },
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

  // .score-must-see and .score-great / .score-good in globals.css set their
  // own background/color/box-shadow/(shimmer ::before). When we use them we
  // skip the inline glow override (would clobber the class's shadow). The
  // `overflow-hidden` is needed for .score-must-see's shimmer pseudo-element.
  const classes = [
    sizeBox,
    styles.criticClass ?? styles.bg ?? '',
    styles.text,
    'rounded-xl flex items-center justify-center font-bold',
    sizeText,
    'relative overflow-hidden',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      style={!styles.criticClass && styles.glow ? { boxShadow: styles.glow } : undefined}
      aria-label={inProgress && score > 0 ? `Provisional Award Score ${score} — ${label}` : `Award Score ${score} — ${label}`}
    >
      {/* Asterisk is absolute so it never displaces the centered number */}
      {inProgress && score > 0 && (
        <span aria-hidden className="absolute top-1.5 right-1.5 animate-pulse font-bold text-sm leading-none">*</span>
      )}
      <span className="leading-none">{score > 0 ? score : '—'}</span>
    </div>
  );
}

export { TIER_LABEL as AWARD_TIER_LABEL };
