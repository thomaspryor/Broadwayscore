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
 * "PREDICTION SCORE" label, with the three input boxes (critic / audience /
 * awards) below at equal size. Used on the predictions hub, per-season list,
 * and report-card sub-rows.
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
  const showAwardsBox = awardsScore !== undefined;
  const hasAwards = typeof awardsScore === 'number' && awardsScore > 0;

  // Three peer boxes share the row — all 44px so ScoreBadge sm matches the
  // audience + awards boxes exactly. No responsive scaling: avoids size
  // mismatch between ScoreBadge and the other two at any viewport.
  const inputBoxClass =
    size === 'sm'
      ? 'w-9 h-9 rounded-lg flex items-center justify-center text-base font-bold'
      : 'w-11 h-11 rounded-lg flex items-center justify-center text-lg font-bold';
  const blendedNumberClass =
    size === 'sm'
      ? 'text-lg font-bold leading-none'
      : 'text-2xl sm:text-3xl font-bold leading-none';

  // Awards box visual treatment:
  //   - weighted (Best Play): brand gold accent so it visibly counts toward the prediction
  //   - unweighted (other categories): muted gray, shown for transparency only
  //   - no data (awardsScore is 0): muted "—", same as audience-grade empty state
  const awardsBoxStyle = hasAwards
    ? awardsWeighted
      ? { backgroundColor: 'rgba(234, 179, 8, 0.15)', color: 'rgb(250, 204, 21)' }   // amber-500/15 + amber-400
      : { backgroundColor: 'rgba(255, 255, 255, 0.05)', color: 'rgb(156, 163, 175)' } // white/5 + gray-400
    : undefined;
  const awardsBoxClassName = hasAwards
    ? inputBoxClass
    : `${inputBoxClass} bg-surface-overlay text-gray-500`;
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
      <div className="flex flex-wrap items-center justify-end gap-1.5 max-w-[96px] sm:max-w-none">
        <ScoreBadge
          score={compositeScore}
          size="sm"
          showCrown={showCrown}
          reviewCount={reviewCount}
          status={status}
        />
        {hasGrade ? (
          <div
            className={inputBoxClass}
            style={{ backgroundColor: `${audienceGrade!.color}20`, color: audienceGrade!.color }}
            title={audienceGrade!.tooltip}
          >
            {audienceGrade!.grade}
          </div>
        ) : (
          <div className={`${inputBoxClass} bg-surface-overlay text-gray-500`}>
            —
          </div>
        )}
        {showAwardsBox && (
          <div
            className={awardsBoxClassName}
            style={awardsBoxStyle}
            title={awardsTooltip}
            aria-label={awardsTooltip}
          >
            {hasAwards ? Math.round(awardsScore!) : '—'}
          </div>
        )}
      </div>
    </div>
  );
}
