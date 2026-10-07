/**
 * AtRiskCard - Card for shows at risk
 * Sprint 2, Task 2.4. BRO-4623: compares the trailing 4-week average gross
 * with the same break-even the show page uses (getBreakEven), and shows the
 * model's optimistic case that put the show on the list.
 */

import Link from 'next/link';
import { getTrendColor, getTrendIcon } from '@/config/commercial';
import type { RecoupmentTrend } from '@/lib/data-types';
import { formatCurrency, formatCapitalization } from '@/lib/biz-format';

interface AtRiskCardProps {
  slug: string;
  title: string;
  season: string;
  capitalization: number | null;
  /** Prints the "~" estimate mark only when true (isEstimatedCapitalization). */
  capitalizationIsEstimate: boolean;
  /** Trailing 4-week average gross. */
  avgWeeklyGross: number;
  /** getBreakEven(): model break-even above the quality floor, else weekly running cost. */
  breakEven: number;
  /** Model [pessimistic, central, optimistic]. */
  modelRecoupmentPct: [number, number, number];
  trend: RecoupmentTrend;
}

const TREND_LABELS: Record<RecoupmentTrend, string> = {
  improving: 'Grosses up',
  steady: 'Grosses steady',
  declining: 'Grosses down',
  unknown: 'Not enough weeks',
};

export default function AtRiskCard({
  slug,
  title,
  season,
  capitalization,
  capitalizationIsEstimate,
  avgWeeklyGross,
  breakEven,
  modelRecoupmentPct,
  trend,
}: AtRiskCardProps) {
  const trendLabel = TREND_LABELS[trend];
  const deficit = Math.max(0, breakEven - avgWeeklyGross);
  const optimistic = Math.max(0, Math.round(modelRecoupmentPct[2]));

  return (
    <Link
      href={`/show/${slug}`}
      className="card rounded-xl p-4 block hover:bg-white/5 transition-colors border-l-2 border-red-500/50"
    >
      <div className="flex justify-between items-start mb-2">
        <h3 className="font-semibold text-white">{title}</h3>
        <span className="text-xs px-2 py-1 rounded-full bg-red-500/20 text-red-400">
          At Risk
        </span>
      </div>
      <div className="text-sm text-gray-400 mb-3">{season} Season</div>
      <div className="flex justify-between text-sm">
        <span className="text-gray-500">Capitalization</span>
        <span className="text-white">{formatCapitalization(capitalization, capitalizationIsEstimate)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Avg gross (4 wks)</span>
        <span className="text-white">{formatCurrency(avgWeeklyGross)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Est. break-even</span>
        <span className="text-white">~{formatCurrency(breakEven)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Gap</span>
        <span className="text-red-400">-{formatCurrency(deficit)} a week</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Est. recouped (best case)</span>
        <span className="text-white">~{optimistic}%</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Trend (4 wks)</span>
        <span className={getTrendColor(trend, false)} aria-label={trendLabel}>
          {getTrendIcon(trend, false)} {trendLabel}
        </span>
      </div>
    </Link>
  );
}
