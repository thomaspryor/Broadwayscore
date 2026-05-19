/**
 * ApproachingRecoupmentCard - Card for shows approaching recoupment
 * Sprint 2, Task 2.3
 */

import Link from 'next/link';
import { getTrendColor, getTrendIcon } from '@/config/commercial';
import type { RecoupmentTrend } from '@/lib/data-types';

interface ApproachingRecoupmentCardProps {
  slug: string;
  title: string;
  season: string;
  capitalization: number | null;
  estimatedRecoupmentPct: [number, number];
  modelRecoupmentPct?: [number, number, number] | null;
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated' | null;
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

// TBD shows are *by definition* not yet declared recouped by their producers.
// If the financial model output exceeds 100% on a TBD show, the model is
// outpacing producer confirmation (or overestimating) — either way, showing
// "105% recouped" while the row carries a TBD pill is contradictory and was
// confusing readers. Cap the displayed central at "≈100%" for these rows;
// the underlying value still flows through to the model audit / contradiction
// flag in merge-model-recoupment.js.
function formatRecoupmentEstimate(
  modelRecoupmentPct: [number, number, number] | null | undefined,
  estimatedRecoupmentPct: [number, number],
): string {
  if (modelRecoupmentPct) {
    const central = modelRecoupmentPct[1];
    if (central >= 100) return '≈100% recouped';
    return `${Math.round(central)}% recouped`;
  }
  const [low, high] = estimatedRecoupmentPct;
  if (high >= 100) return `~${low}-100%+ recouped`;
  return `~${low}-${high}% recouped`;
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
  modelRecoupmentPct,
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
        <span className="text-white">
          {capitalization == null ? 'Unknown' : `~${formatCurrency(capitalization)}`}
        </span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Est. Recouped</span>
        <span className="text-amber-400 font-semibold">
          {formatRecoupmentEstimate(modelRecoupmentPct, estimatedRecoupmentPct)}
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
