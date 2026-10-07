import type { TierBadge } from '@/lib/awards-scoring';

interface AwardScoreBadgeProps {
  score: number;
  badge: TierBadge;
  inProgress: boolean;
  size?: 'sm' | 'md' | 'lg';
}

// Award badge — round "medal" treatment (2026-05-17 v2):
//   • Top 3 tiers = Olympic medals (gold / silver / bronze) with metallic
//     gradients + shimmer light-sweep (same shimmer as critic .score-must-see).
//   • Bottom 3 tiers = subdued outlined circles (no fill, faint white border),
//     dashed for Eligible so it reads as "potential, not realized."
//   • inProgress (Tony season open) = subtle whole-badge breathing animation
//     via `award-breathe` keyframe in globals.css. Replaces the prior asterisk
//     overlay — the breath IS the "score is alive" signal.
//
// Distinct shape (circle) keeps award badges visually separate from critic
// ScoreBadge (rounded squares) so they don't read as the same thing on the
// /award-score leaderboard. Gold/silver/bronze palette decouples from the
// critic gold/emerald/teal so the two systems never collide.

interface TierStyle {
  fillBg: string;       // CSS background (gradient or transparent)
  ring: string;         // CSS border ("medal rim" or outline)
  text: string;         // Tailwind text class for the score digit
  label: string;        // Tailwind text class for the tier name (used by card)
  glow: string;         // CSS box-shadow
  shimmer?: boolean;    // Top 3 tiers — animated light-sweep across the badge
}

const TIER_STYLES: Record<TierBadge, TierStyle> = {
  // ── Medal tiers ──────────────────────────────────────────────────────
  sweeper: {
    fillBg: 'linear-gradient(135deg, #C9A227 0%, #F7D560 30%, #FFF1B5 50%, #F7D560 70%, #C9A227 100%)',
    ring: '2px solid rgba(255, 232, 117, 0.85)',
    text: 'text-amber-950',
    label: 'text-amber-400',
    glow: '0 0 16px rgba(247, 213, 96, 0.4), inset 0 1px 3px rgba(255,255,255,0.4)',
    shimmer: true,
  },
  decorated: {
    fillBg: 'linear-gradient(135deg, #9a9a9a 0%, #D0D0D0 30%, #F0F0F0 50%, #D0D0D0 70%, #9a9a9a 100%)',
    ring: '2px solid rgba(240, 240, 240, 0.7)',
    text: 'text-gray-900',
    label: 'text-gray-300',
    glow: '0 0 14px rgba(200,200,200,0.3), inset 0 1px 3px rgba(255,255,255,0.4)',
    shimmer: true,
  },
  honored: {
    fillBg: 'linear-gradient(135deg, #8a4a23 0%, #C2773A 30%, #D89668 50%, #C2773A 70%, #8a4a23 100%)',
    ring: '2px solid rgba(216, 150, 104, 0.75)',
    text: 'text-amber-950',
    label: 'text-orange-400',
    glow: '0 0 14px rgba(194, 119, 58, 0.35), inset 0 1px 3px rgba(255,200,150,0.3)',
    shimmer: true,
  },
  // ── Subdued outlined tiers ───────────────────────────────────────────
  'in-the-hunt': {
    fillBg: 'rgba(255, 255, 255, 0.04)',
    ring: '1.5px solid rgba(255, 255, 255, 0.35)',
    text: 'text-white/80',
    label: 'text-gray-300',
    glow: 'none',
  },
  nominated: {
    fillBg: 'rgba(255, 255, 255, 0.03)',
    ring: '1.5px solid rgba(255, 255, 255, 0.22)',
    text: 'text-white/55',
    label: 'text-gray-400',
    glow: 'none',
  },
  eligible: {
    fillBg: 'transparent',
    ring: '1.5px dashed rgba(255, 255, 255, 0.18)',
    text: 'text-white/40',
    label: 'text-gray-500',
    glow: 'none',
  },
};

// Pre-ceremony: neutral white-outline ring — no tier color until winners are announced
const PRE_CEREMONY: TierStyle = {
  fillBg: 'transparent',
  ring: '1.5px solid rgba(255, 255, 255, 0.35)',
  text: 'text-white',
  label: 'text-gray-400',
  glow: 'none',
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
  const styles = inProgress && score > 0
    ? PRE_CEREMONY
    : score > 0
      ? TIER_STYLES[badge]
      : TIER_STYLES.eligible;
  const label = inProgress && badge === 'nominated' ? 'In the Hunt' : TIER_LABEL[badge];

  const sizeBox = size === 'lg' ? 'w-16 h-16 sm:w-20 sm:h-20' : size === 'md' ? 'w-14 h-14 lg:w-[68px] lg:h-[68px]' : 'w-11 h-11 lg:w-[68px] lg:h-[68px]';
  const sizeText = size === 'lg' ? 'text-3xl' : size === 'md' ? 'text-2xl lg:text-3xl' : 'text-lg lg:text-3xl';

  // inProgress → whole badge breathes (replaces prior asterisk). Uses the
  // `award-breathe` keyframe defined in globals.css.
  const breatheStyle = inProgress && score > 0
    ? { animation: 'award-breathe 2.5s ease-in-out infinite' }
    : undefined;

  return (
    <div
      className={`${sizeBox} ${styles.text} rounded-full flex items-center justify-center font-bold ${sizeText} relative overflow-hidden`}
      style={{
        background: styles.fillBg,
        border: styles.ring,
        boxShadow: styles.glow,
        ...breatheStyle,
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
            background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent)',
            animation: 'shimmer 2.5s infinite',
            pointerEvents: 'none',
          }}
        />
      )}
      <span className="leading-none relative">{score > 0 ? score : '—'}</span>
    </div>
  );
}

export { TIER_LABEL as AWARD_TIER_LABEL };
