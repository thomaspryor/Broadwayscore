/**
 * AtRiskCard - Card for shows at risk (below break-even or declining)
 * Sprint 2, Task 2.4
 */

import Link from 'next/link';
import type { RecoupmentTrend } from '@/lib/data';

interface AtRiskCardProps {
  slug: string;
  title: string;
  season: string;
  capitalization: number;
  weeklyGross: number;
  breakEven: number;
  trend: RecoupmentTrend;
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(2)}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(0)}K`;
  }
  return `$${amount}`;
}

function getTrendDisplay(trend: RecoupmentTrend): {
  icon: string;
  label: string;
  className: string;
} {
  switch (trend) {
    case 'improving':
      return { icon: '↑', label: 'Improving', className: 'text-emerald-400' };
    case 'steady':
      return { icon: '→', label: 'Steady', className: 'text-gray-400' };
    case 'declining':
      return { icon: '↓', label: 'Declining', className: 'text-red-400' };
    default:
      return { icon: '?', label: 'Unknown', className: 'text-gray-500' };
  }
}

export default function AtRiskCard({
  slug,
  title,
  season,
  capitalization,
  weeklyGross,
  breakEven,
  trend,
}: AtRiskCardProps) {
  const trendDisplay = getTrendDisplay(trend);
  const deficit = breakEven - weeklyGross;
  const isBelowBreakEven = weeklyGross < breakEven;

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
        <span className="text-gray-500">Investment</span>
        <span className="text-white">~{formatCurrency(capitalization)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Weekly Gross</span>
        <span className="text-white">{formatCurrency(weeklyGross)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Break-even</span>
        <span className="text-white">~{formatCurrency(breakEven)}</span>
      </div>
      <div className="flex justify-between text-sm mt-1">
        <span className="text-gray-500">Trend</span>
        <span className={trendDisplay.className} aria-label={trendDisplay.label}>
          {trendDisplay.icon}{' '}
          {isBelowBreakEven
            ? `Below break-even (-${formatCurrency(deficit)})`
            : trendDisplay.label}
        </span>
      </div>
    </Link>
  );
}
