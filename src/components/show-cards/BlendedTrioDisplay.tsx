import { ScoreBadge, getScoreTier } from './ScoreBadge';
import type { AudienceGrade } from './types';

export interface BlendedTrioDisplayProps {
  blendedScore: number | null;
  compositeScore: number | null;
  reviewCount: number;
  status: string;
  audienceGrade: AudienceGrade | null;
  size?: 'sm' | 'md';
  showCrown?: boolean;
}

/**
 * Tony predictions score display: prominent blended score on top, with the
 * critic ScoreBadge and audience grade box (the two inputs) below at equal size.
 * Used on the predictions hub, per-season list, and report-card sub-rows.
 */
export function BlendedTrioDisplay({
  blendedScore,
  compositeScore,
  reviewCount,
  status,
  audienceGrade,
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

  const audienceBoxClass =
    size === 'sm'
      ? 'w-11 h-11 rounded-lg flex items-center justify-center text-lg font-bold'
      : 'w-12 h-12 sm:w-14 sm:h-14 rounded-xl flex items-center justify-center text-xl sm:text-2xl font-bold';
  const blendedNumberClass =
    size === 'sm'
      ? 'text-xl font-bold leading-none'
      : 'text-2xl sm:text-3xl font-bold leading-none';

  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0">
      {showTier && (
        <>
          {tier && (
            <span
              className="text-[9px] font-semibold uppercase tracking-wide whitespace-nowrap"
              style={{ color: tier.color }}
            >
              {tier.label}
            </span>
          )}
          <span
            className={blendedNumberClass}
            style={tier ? { color: tier.color } : undefined}
          >
            {Math.round(blendedScore!)}
          </span>
        </>
      )}
      <div className="flex items-center gap-1.5">
        <ScoreBadge
          score={compositeScore}
          size={size}
          showCrown={showCrown}
          reviewCount={reviewCount}
          status={status}
        />
        {hasGrade ? (
          <div
            className={audienceBoxClass}
            style={{ backgroundColor: `${audienceGrade!.color}20`, color: audienceGrade!.color }}
            title={audienceGrade!.tooltip}
          >
            {audienceGrade!.grade}
          </div>
        ) : (
          <div className={`${audienceBoxClass} bg-surface-overlay text-gray-500`}>
            —
          </div>
        )}
      </div>
    </div>
  );
}
