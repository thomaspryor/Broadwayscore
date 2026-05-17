import type { TierBadge } from '@/lib/awards-scoring';

interface AwardScoreBadgeProps {
  score: number;
  badge: TierBadge;
  inProgress: boolean;
  size?: 'sm' | 'md' | 'lg';
}

// Award badge — round "medal" shape with a lighter-tier-color ring (2026-05-17).
// Distinct from critic ScoreBadge (rounded square + filled bg + no ring) so the
// two never read as the same thing on standalone surfaces like /award-score.
// Fills + glows mirror the critic positive tiers so a Sweeper 100 still feels
// related to a Critical Gold 91 (same gold gradient + shimmer for top tier),
// but the SHAPE (circle vs rounded square) carries the disambiguation.
//
// We rebuilt these styles inline rather than reusing the critic .score-must-see
// / .score-great / .score-good CSS classes because (a) those classes hard-code
// `border: 2px solid #C8960E` which fights our ring, and (b) coupling the
// award component to critic CSS makes future independent tweaks dangerous.

interface TierStyle {
  fillBg: string;       // CSS background (gradient or solid color)
  ring: string;         // CSS border — the "medal rim" in a lighter tier color
  text: string;         // Tailwind text class for the score digit
  label: string;        // Tailwind text class for the tier name (used by card)
  glow: string;         // CSS box-shadow
  shimmer?: boolean;    // Sweeper only — animated light-sweep overlay
}

const TIER_STYLES: Record<TierBadge, TierStyle> = {
  sweeper: {
    fillBg: 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)',
    ring: '2px solid rgba(255, 232, 117, 0.85)',   // lighter gold rim
    text: 'text-amber-950',
    label: 'text-amber-400',
    glow: '0 0 18px rgba(255, 215, 0, 0.45), 0 4px 12px rgba(0,0,0,0.3), inset 0 2px 0 rgba(255,255,255,0.3)',
    shimmer: true,
  },
  decorated: {
    fillBg: '#22c55e',                              // emerald-500 (matches .score-great)
    ring: '2px solid rgba(110, 231, 183, 0.7)',    // emerald-300 rim
    text: 'text-white',
    label: 'text-emerald-400',
    glow: '0 0 14px rgba(34, 197, 94, 0.4), 0 2px 8px rgba(0,0,0,0.25)',
  },
  honored: {
    fillBg: '#14b8a6',                              // teal-500 (matches .score-good)
    ring: '2px solid rgba(94, 234, 212, 0.7)',     // teal-300 rim
    text: 'text-white',
    label: 'text-teal-400',
    glow: '0 0 14px rgba(20, 184, 166, 0.4), 0 2px 8px rgba(0,0,0,0.25)',
  },
  'in-the-hunt': {
    fillBg: 'rgba(180, 83, 9, 0.5)',                // amber-700/50
    ring: '2px solid rgba(252, 211, 77, 0.4)',     // amber-300/40 rim
    text: 'text-amber-100',
    label: 'text-amber-300',
    glow: '0 2px 6px rgba(0,0,0,0.25)',
  },
  nominated: {
    fillBg: 'rgba(42, 42, 56, 1)',                  // bg-surface-overlay
    ring: '2px solid rgba(245, 158, 11, 0.3)',     // amber-500/30 rim
    text: 'text-amber-200',
    label: 'text-amber-200',
    glow: 'none',
  },
  eligible: {
    fillBg: 'rgba(255, 255, 255, 0.08)',            // ~bg-white/8
    ring: '2px solid rgba(255, 255, 255, 0.15)',
    text: 'text-gray-400',
    label: 'text-gray-400',
    glow: 'none',
  },
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

  const sizeBox = size === 'lg' ? 'w-16 h-16 sm:w-20 sm:h-20' : size === 'md' ? 'w-14 h-14' : 'w-11 h-11';
  const sizeText = size === 'lg' ? 'text-3xl' : size === 'md' ? 'text-2xl' : 'text-lg';

  return (
    <div
      className={`${sizeBox} ${styles.text} rounded-full flex items-center justify-center font-bold ${sizeText} relative overflow-hidden`}
      style={{
        background: styles.fillBg,
        border: styles.ring,
        boxShadow: styles.glow,
      }}
      aria-label={inProgress && score > 0 ? `Provisional Award Score ${score} — ${label}` : `Award Score ${score} — ${label}`}
    >
      {styles.shimmer && (
        // Animated light-sweep, mirrors .score-must-see::before in globals.css.
        // The @keyframes shimmer rule is defined in globals.css.
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: '-100%',
            width: '100%',
            height: '100%',
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
            animation: 'shimmer 2.5s infinite',
            pointerEvents: 'none',
          }}
        />
      )}
      {/* Asterisk absolutely positioned so it never displaces the centered number */}
      {inProgress && score > 0 && (
        <span aria-hidden className="absolute top-1.5 right-1.5 animate-pulse font-bold text-sm leading-none">*</span>
      )}
      <span className="leading-none">{score > 0 ? score : '—'}</span>
    </div>
  );
}

export { TIER_LABEL as AWARD_TIER_LABEL };
