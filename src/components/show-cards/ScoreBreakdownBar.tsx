import { getGoldThreshold } from '@/config/score-buckets';

/**
 * Breakdown bar tiers. Intentionally diverge from the 5-tier ScoreBadge taxonomy
 * (Critical Gold / Recommended / Worth Seeing / Skippable / Critical Miss): a single
 * review shows its full badge on the review card, but in the aggregate breakdown
 * we use four simpler sentiment labels.
 *
 * Thresholds:
 *   Rave     = score >= gold threshold (83 Broadway / 85 West End)
 *   Positive = 70 to gold-1
 *   Mixed    = 55 to 69
 *   Negative = < 55
 *
 * The 70 boundary is deliberately lower than the Recommended badge (75). A 72 in
 * our scoring is a soft recommend — not a mixed review — so it belongs in the
 * Positive camp on the breakdown bar even though its badge reads "Worth Seeing".
 */
export type BreakdownTier = 'rave' | 'positive' | 'mixed' | 'negative';

/**
 * Classify a single review score into one of four breakdown tiers.
 * Returns null for non-finite inputs (null, undefined, NaN, Infinity) so the
 * caller can filter them out rather than silently counting them as Negative.
 */
export function getBreakdownTier(
  score: number | null | undefined,
  category?: string
): BreakdownTier | null {
  if (!Number.isFinite(score)) return null;
  const rounded = Math.round(score as number);
  if (rounded >= getGoldThreshold(category)) return 'rave';
  if (rounded >= 70) return 'positive';
  if (rounded >= 55) return 'mixed';
  return 'negative';
}

/**
 * Largest-remainder (Hamilton method) percentage allocation. Given tier counts
 * that sum to `total`, returns integer percentages that sum to exactly 100 and
 * never assign a non-zero percentage to a tier with a zero count. Prevents the
 * "ghost sliver" bug where compound rounding of `100 - a - b - c` renders a 1%
 * segment for a tier that has no reviews.
 */
function allocatePercentages(counts: Record<BreakdownTier, number>, total: number): Record<BreakdownTier, number> {
  const tiers: BreakdownTier[] = ['rave', 'positive', 'mixed', 'negative'];
  const exact = tiers.map(t => (counts[t] / total) * 100);
  const floors = exact.map(Math.floor);
  const sumFloors = floors.reduce((a, b) => a + b, 0);
  let remainder = 100 - sumFloors;
  // Distribute remainder to tiers with the largest fractional parts first.
  // Zero-count tiers have exact=0, fraction=0, so they sort last and never
  // receive a bump (which is what we want).
  const order = exact
    .map((v, i) => ({ frac: v - Math.floor(v), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < order.length && remainder > 0; k++) {
    const idx = order[k].i;
    if (counts[tiers[idx]] === 0) continue; // never bump a zero-count tier
    floors[idx]++;
    remainder--;
  }
  return {
    rave: floors[0],
    positive: floors[1],
    mixed: floors[2],
    negative: floors[3],
  };
}

interface ScoreBreakdownBarProps {
  reviews: { reviewScore: number | null | undefined }[];
  category?: string;
  className?: string;
  /** Hide this instance from screen readers — use on duplicate responsive copies. */
  ariaHidden?: boolean;
}

export function ScoreBreakdownBar({ reviews, category, className = '', ariaHidden }: ScoreBreakdownBarProps) {
  // Count reviews into tiers. Non-finite scores (null/undefined/NaN) are skipped
  // via getBreakdownTier() returning null, so they don't silently count as Negative.
  const counts: Record<BreakdownTier, number> = { rave: 0, positive: 0, mixed: 0, negative: 0 };
  let total = 0;
  for (const r of reviews) {
    const tier = getBreakdownTier(r.reviewScore, category);
    if (!tier) continue;
    counts[tier]++;
    total++;
  }
  if (total === 0) return null;

  const pcts = allocatePercentages(counts, total);

  const ariaLabel =
    `${total} ${total === 1 ? 'review' : 'reviews'}: ` +
    [
      counts.rave > 0 ? `${counts.rave} ${counts.rave === 1 ? 'rave' : 'raves'}` : null,
      counts.positive > 0 ? `${counts.positive} positive` : null,
      counts.mixed > 0 ? `${counts.mixed} mixed` : null,
      counts.negative > 0 ? `${counts.negative} negative` : null,
    ]
      .filter(Boolean)
      .join(', ');

  return (
    <div
      className={`space-y-1 ${className}`}
      {...(ariaHidden ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': ariaLabel })}
    >
      <div className="h-2 rounded-full overflow-hidden flex bg-surface-overlay">
        {counts.rave > 0 && <div className="bg-score-must-see h-full" style={{ width: `${pcts.rave}%` }} />}
        {counts.positive > 0 && <div className="bg-score-great h-full" style={{ width: `${pcts.positive}%` }} />}
        {counts.mixed > 0 && <div className="bg-score-tepid h-full" style={{ width: `${pcts.mixed}%` }} />}
        {counts.negative > 0 && <div className="bg-score-skip h-full" style={{ width: `${pcts.negative}%` }} />}
      </div>
      {/* Legend — flex-nowrap so labels never wrap onto a second line on mobile */}
      <div className="flex items-center flex-nowrap justify-between gap-1.5 sm:gap-3 text-[10px] sm:text-xs whitespace-nowrap">
        {counts.rave > 0 && (
          <div className="flex items-center gap-1 min-w-0">
            <div className="w-2 h-2 rounded-sm bg-score-must-see flex-shrink-0" />
            <span className="text-gray-400">{counts.rave} Rave</span>
          </div>
        )}
        {counts.positive > 0 && (
          <div className="flex items-center gap-1 min-w-0">
            <div className="w-2 h-2 rounded-sm bg-score-great flex-shrink-0" />
            <span className="text-gray-400">{counts.positive} Positive</span>
          </div>
        )}
        {counts.mixed > 0 && (
          <div className="flex items-center gap-1 min-w-0">
            <div className="w-2 h-2 rounded-sm bg-score-tepid flex-shrink-0" />
            <span className="text-gray-400">{counts.mixed} Mixed</span>
          </div>
        )}
        {counts.negative > 0 && (
          <div className="flex items-center gap-1 min-w-0">
            <div className="w-2 h-2 rounded-sm bg-score-skip flex-shrink-0" />
            <span className="text-gray-400">{counts.negative} Negative</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default ScoreBreakdownBar;
