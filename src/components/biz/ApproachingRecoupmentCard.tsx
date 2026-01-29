/**
 * ApproachingRecoupmentCard - Card for shows approaching recoupment
 * Sprint 2, Task 2.3
 */

import Link from 'next/link';
import { getTrendColor, getTrendIcon } from '@/config/commercial';
import type { RecoupmentTrend } from '@/lib/data';

interface ApproachingRecoupmentCardProps {
  slug: string;
  title: string;
  season: string;
  capitalization: number;
  estimatedRecoupmentPct: [number, number];
  trend: RecoupmentTrend;
  weeklyGross?: number | null;
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(1)}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(0)}K`;
  }
  return `$${amount}`;
}

const TREND_LABELS: Record<RecoupmentTrend, string> = {
  improving: 'Improving',
  steady: 'Steady',
  declining: 'Declining',
  unknown: 'Unknown',
};

export default function ApproachingRecoupmentCard({
  slug,
  title,
  season,
  capitalization,
  estimatedRecoupmentPct,
  trend,
}: ApproachingRecoupmentCardProps) {
  const trendLabel = TREND_LABELS[trend];

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
        <span className="text-gray-500">Investment</span>
        <span className="text-white">~{formatCurrency(capitalization)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Est. Recouped</span>
        <span className="text-amber-400 font-semibold">
          ~{estimatedRecoupmentPct[0]}-{estimatedRecoupmentPct[1]}% recouped
        </span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Trend</span>
        <span className={getTrendColor(trend, false)} aria-label={trendLabel}>
          {getTrendIcon(trend, false)} {trendLabel}
        </span>
      </div>
    </Link>
  );
}
