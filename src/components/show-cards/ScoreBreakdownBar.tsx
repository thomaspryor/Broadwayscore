import { getGoldThreshold } from '@/config/score-buckets';

/**
 * Breakdown bar tiers. Intentionally diverge from the 5-tier ScoreBadge taxonomy
 * (Critical Gold / Recommended / Worth Seeing / Skippable / Stay Away): a single
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

export function getBreakdownTier(score: number, category?: string): BreakdownTier {
  const rounded = Math.round(score);
  if (rounded >= getGoldThreshold(category)) return 'rave';
  if (rounded >= 70) return 'positive';
  if (rounded >= 55) return 'mixed';
  return 'negative';
}

interface ScoreBreakdownBarProps {
  reviews: { reviewScore: number }[];
  category?: string;
  className?: string;
}

export function ScoreBreakdownBar({ reviews, category, className = '' }: ScoreBreakdownBarProps) {
  const total = reviews.length;
  if (total === 0) return null;

  const counts = { rave: 0, positive: 0, mixed: 0, negative: 0 };
  for (const r of reviews) {
    counts[getBreakdownTier(r.reviewScore, category)]++;
  }

  // Percentages that sum to exactly 100 even with rounding.
  const ravePct = Math.round((counts.rave / total) * 100);
  const posPct = Math.round((counts.positive / total) * 100);
  const mixPct = Math.round((counts.mixed / total) * 100);
  const negPct = 100 - ravePct - posPct - mixPct;

  return (
    <div className={`space-y-1 ${className}`}>
      <div className="h-2 rounded-full overflow-hidden flex bg-surface-overlay">
        {ravePct > 0 && <div className="bg-score-must-see h-full" style={{ width: `${ravePct}%` }} />}
        {posPct > 0 && <div className="bg-score-great h-full" style={{ width: `${posPct}%` }} />}
        {mixPct > 0 && <div className="bg-score-tepid h-full" style={{ width: `${mixPct}%` }} />}
        {negPct > 0 && <div className="bg-score-skip h-full" style={{ width: `${negPct}%` }} />}
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
