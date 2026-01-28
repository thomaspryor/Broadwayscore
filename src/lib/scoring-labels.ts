/**
 * Shared tier label utility for audience-facing score labels.
 * Used by the rating widget, community score display, and audience buzz sections.
 *
 * Thresholds align with the critic score tiers but use audience-friendly language:
 *   85+  → Must-See
 *   75-84 → Recommended
 *   65-74 → Worth Seeing
 *   55-64 → Skippable
 *   <55  → Stay Away
 */
export function getTierLabel(score: number): { label: string; colorClass: string } {
  const rounded = Math.round(score);
  if (rounded >= 85) return { label: 'Must-See', colorClass: 'text-score-must-see' };
  if (rounded >= 75) return { label: 'Recommended', colorClass: 'text-score-great' };
  if (rounded >= 65) return { label: 'Worth Seeing', colorClass: 'text-score-good' };
  if (rounded >= 55) return { label: 'Skippable', colorClass: 'text-score-tepid' };
  return { label: 'Stay Away', colorClass: 'text-score-skip' };
}
