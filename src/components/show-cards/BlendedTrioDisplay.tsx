import { ScoreBadge, getScoreTier } from './ScoreBadge';
import { AwardScoreBadge } from './AwardScoreBadge';
import type { TierBadge } from '@/lib/awards-scoring';
import type { AudienceGrade } from './types';

function awardBadgeFromScore(score: number | null | undefined): TierBadge {
  if (!score || score <= 0) return 'eligible';
  if (score <= 40) return 'nominated';
  if (score <= 69) return 'honored';
  if (score <= 84) return 'decorated';
  return 'sweeper';
}

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
  /** Hide the "Prediction Score" header + blended number (e.g. when win% is shown alongside) */
  hideScore?: boolean;
  /** True when the Tony ceremony hasn't happened yet (activates award-breathe animation) */
  inProgress?: boolean;
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
  hideScore = false,
  inProgress = true,
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

  // All three peer boxes share the same dimensions — match ScoreBadge sm (w-11 h-11 = 44px).
  const boxClass =
    size === 'sm'
      ? 'w-11 h-11 rounded-lg flex items-center justify-center text-base font-bold'
      : 'w-11 h-11 rounded-lg flex items-center justify-center text-lg font-bold';
  const blendedNumberClass =
    size === 'sm'
      ? 'text-lg font-bold leading-none'
      : 'text-2xl sm:text-3xl font-bold leading-none';
  const labelClass = 'text-[9px] font-semibold uppercase tracking-wide text-gray-400';


  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0">
      {showTier && !hideScore && (
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
            <AwardScoreBadge
              score={Math.round(awardsScore ?? 0)}
              badge={awardBadgeFromScore(awardsScore)}
              inProgress={inProgress}
              size="sm"
            />
          </div>
        )}
      </div>
    </div>
  );
}
