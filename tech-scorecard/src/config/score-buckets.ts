// Thresholds copied from Broadway Scorecard (scripts/lib/score-tiers.js).
export const GOLD_MIN = 83;
export const RECOMMENDED_MIN = 75;
export const WORTH_IT_MIN = 65;
export const MIXED_MIN = 55;

export type TierKey = 'gold' | 'recommended' | 'worthIt' | 'mixed' | 'miss';

export const SCORE_TIERS: Record<TierKey, { label: string; blurb: string; badgeClass: string; textClass: string }> = {
  gold: { label: 'Critical Gold', blurb: 'Best in class. If you are buying one, buy this.', badgeClass: 'score-must-see', textClass: 'text-[#b8860b]' },
  recommended: { label: 'Recommended', blurb: 'A strong buy for most people.', badgeClass: 'score-great', textClass: 'text-score-great' },
  worthIt: { label: 'Worth a Look', blurb: 'Good, with caveats. Best if its strengths are your priorities.', badgeClass: 'score-good', textClass: 'text-score-good' },
  mixed: { label: 'Mixed', blurb: 'Critics are split.', badgeClass: 'score-tepid', textClass: 'text-score-tepid' },
  miss: { label: 'Critical Miss', blurb: 'Not recommended.', badgeClass: 'score-skip', textClass: 'text-score-skip' },
};

export function getTierKey(score: number): TierKey {
  const s = Math.round(score);
  if (s >= GOLD_MIN) return 'gold';
  if (s >= RECOMMENDED_MIN) return 'recommended';
  if (s >= WORTH_IT_MIN) return 'worthIt';
  if (s >= MIXED_MIN) return 'mixed';
  return 'miss';
}

export function getScoreTier(score: number) {
  return SCORE_TIERS[getTierKey(score)];
}

/** Breakdown-bar labels per tier, so the bar and the badge colors always agree. */
export const BREAKDOWN_LABELS: Record<TierKey, { label: string; color: string }> = {
  gold: { label: 'Rave', color: '#f5c518' },
  recommended: { label: 'Positive', color: '#22c55e' },
  worthIt: { label: 'Favorable', color: '#14b8a6' },
  mixed: { label: 'Mixed', color: '#f59e0b' },
  miss: { label: 'Negative', color: '#ef4444' },
};
export const TIER_ORDER: TierKey[] = ['gold', 'recommended', 'worthIt', 'mixed', 'miss'];
