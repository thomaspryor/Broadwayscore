/**
 * ApproachingRecoupmentCard - Card for shows approaching recoupment
 * Sprint 2, Task 2.3. BRO-4623: model estimate shown with its range, and only
 * for shows whose pessimistic case is already 50%+ (getShowsApproachingRecoupment).
 */

import Link from 'next/link';
import { getTrendColor, getTrendIcon } from '@/config/commercial';
import type { RecoupmentTrend } from '@/lib/data-types';
import { formatCapitalization } from '@/lib/biz-format';
import { getModelRecoupmentLabels } from '@/lib/commercial-display';

interface ApproachingRecoupmentCardProps {
  slug: string;
  title: string;
  season: string;
  capitalization: number | null;
  /** Prints the "~" estimate mark only when true (isEstimatedCapitalization). */
  capitalizationIsEstimate: boolean;
  /** Model [pessimistic, central, optimistic], already past the display quality floor. */
  modelRecoupmentPct: [number, number, number];
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated' | null;
  trend: RecoupmentTrend;
  weeklyGross?: number | null;
}

const TREND_LABELS: Record<RecoupmentTrend, string> = {
  improving: 'Grosses up',
  steady: 'Grosses steady',
  declining: 'Grosses down',
  unknown: 'Not enough weeks',
};

export default function ApproachingRecoupmentCard({
  slug,
  title,
  season,
  capitalization,
  capitalizationIsEstimate,
  modelRecoupmentPct,
  trend,
}: ApproachingRecoupmentCardProps) {
  const trendLabel = TREND_LABELS[trend];
  const labels = getModelRecoupmentLabels(modelRecoupmentPct);

  return (
    <Link
      href={`/show/${slug}`}
      className="card rounded-xl p-4 block hover:bg-white/5 transition-colors"
    >
      <div className="flex justify-between items-start mb-2">
        <h3 className="font-semibold text-white">{title}</h3>
        <span className="text-xs px-2 py-1 rounded-full bg-amber-500/20 text-amber-400">
          TBD
        </span>
      </div>
      <div className="text-sm text-gray-400 mb-3">{season} Season</div>
      <div className="flex justify-between text-sm">
        <span className="text-gray-500">Capitalization</span>
        <span className="text-white">{formatCapitalization(capitalization, capitalizationIsEstimate)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Est. recouped</span>
        <span className="text-amber-400 font-semibold" aria-label={labels.ariaLabel}>
          ~{labels.valueText}
        </span>
      </div>
      {labels.rangeLabel && (
        <div className="flex justify-between text-xs mt-0.5">
          <span className="text-gray-500">Model range</span>
          <span className="text-gray-400">{labels.rangeLabel.replace(/^Range: /, '')}</span>
        </div>
      )}
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Trend (4 wks)</span>
        <span className={getTrendColor(trend, false)} aria-label={trendLabel}>
          {getTrendIcon(trend, false)} {trendLabel}
        </span>
      </div>
    </Link>
  );
}
