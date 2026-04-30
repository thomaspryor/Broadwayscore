import { ScoreBadge, getScoreTier } from './ScoreBadge';
import type { AudienceGrade } from './types';

export interface BlendedTrioDisplayProps {
  blendedScore: number | null;
  compositeScore: number | null;
  reviewCount: number;
  status: string;
  audienceGrade: AudienceGrade | null;
  /** 0-100 Awards Score from precursor nominations (Drama League, OCC, Drama Desk). */
  awardsScore?: number | null;
  /** True when the category recipe weights Awards Score in the composite (only Best Play). */
  awardsWeighted?: boolean;
  size?: 'sm' | 'md';
  showCrown?: boolean;
}

/**
 * Tony predictions score display: prominent prediction score on top with a
 * "PREDICTION SCORE" label, with the three labeled input boxes (critic /
 * audience / awards) below at equal size. Used on the predictions hub,
 * per-season list, and report-card sub-rows.
 *
 * The audience grade tile uses the canonical Audience Scorecard styling:
 * `audience-top-grade` for A+ (gradient + glow) and solid bg + textColor
 * for the rest. Don't switch to faded ${color}20 + colored text — the user
 * specifically asked for this to match the show-page Audience Scorecard
 * (2026-04-30).
 */
export function BlendedTrioDisplay({
  blendedScore,
  compositeScore,
  reviewCount,
  status,
  audienceGrade,
  awardsScore,
  awardsWeighted,
  size = 'md',
  showCrown,
}: BlendedTrioDisplayProps) {
  const showTier =
    blendedScore != null &&
    reviewCount >= 5 &&
    status !== 'previews' &&
    status !== 'upcoming';
  const tier = showTier ? getScoreTier(blendedScore) : null;
  const hasGrade = audienceGrade && audienceGrade.grade !== '—';
  const isAplus = hasGrade && audienceGrade!.grade === 'A+';
  const showAwardsBox = awardsScore !== undefined;
  const hasAwards = typeof awardsScore === 'number' && awardsScore > 0;

  // All three peer boxes share the same dimensions — match ScoreBadge sm
  // (44px) at every viewport so they read as equal-weight inputs.
  const boxClass =
    size === 'sm'
      ? 'w-9 h-9 rounded-lg flex items-center justify-center text-base font-bold'
      : 'w-11 h-11 rounded-lg flex items-center justify-center text-lg font-bold';
  const blendedNumberClass =
    size === 'sm'
      ? 'text-lg font-bold leading-none'
      : 'text-2xl sm:text-3xl font-bold leading-none';
  const labelClass = 'text-[9px] font-semibold uppercase tracking-wide text-gray-400';

  // Awards box visual treatment:
  //   - weighted (Best Play):    brand gold accent (counts toward the prediction)
  //   - unweighted (others):     muted gray (shown for transparency only)
  //   - no data (score is 0):    muted "—" (same as audience empty state)
  const awardsBoxStyle = hasAwards
    ? awardsWeighted
      ? { backgroundColor: 'rgba(234, 179, 8, 0.15)', color: 'rgb(250, 204, 21)' }   // amber-500/15 + amber-400
      : { backgroundColor: 'rgba(255, 255, 255, 0.05)', color: 'rgb(156, 163, 175)' } // white/5 + gray-400
    : undefined;
  const awardsBoxClassName = hasAwards
    ? boxClass
    : `${boxClass} bg-surface-overlay text-gray-500`;
  const awardsTooltip = hasAwards
    ? awardsWeighted
      ? `Awards Score ${Math.round(awardsScore!)} — counts for 20% of the Best Play prediction.`
      : `Awards Score ${Math.round(awardsScore!)} — shown for transparency; not weighted in this category's prediction.`
    : 'No precursor nominations yet.';

  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0">
      {showTier && (
        <>
          <span className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap text-white">
            Prediction Score
          </span>
          <span
            className={blendedNumberClass}
            style={tier ? { color: tier.color } : undefined}
          >
            {Math.round(blendedScore!)}
          </span>
        </>
      )}
      <div className="flex flex-wrap items-start justify-end gap-1.5 max-w-[100px] sm:max-w-none">
        {/* Critics column */}
        <div className="flex flex-col items-center gap-1">
          <span className={labelClass}>Critics</span>
          <ScoreBadge
            score={compositeScore}
            size="sm"
            showCrown={showCrown}
            reviewCount={reviewCount}
            status={status}
          />
        </div>

        {/* Audience column */}
        <div className="flex flex-col items-center gap-1">
          <span className={labelClass}>Audience</span>
          {hasGrade ? (
            <div
              className={`${boxClass} shadow-sm ${isAplus ? 'audience-top-grade' : ''}`}
              style={isAplus ? undefined : { backgroundColor: audienceGrade!.color, color: audienceGrade!.textColor }}
              title={audienceGrade!.tooltip}
            >
              {audienceGrade!.grade}
            </div>
          ) : (
            <div className={`${boxClass} bg-surface-overlay text-gray-500`}>
              —
            </div>
          )}
        </div>

        {/* Awards column (only when awardsScore is provided) */}
        {showAwardsBox && (
          <div className="flex flex-col items-center gap-1">
            <span className={labelClass}>Awards</span>
            <div
              className={awardsBoxClassName}
              style={awardsBoxStyle}
              title={awardsTooltip}
              aria-label={awardsTooltip}
            >
              {hasAwards ? Math.round(awardsScore!) : '—'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
