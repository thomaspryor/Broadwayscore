'use client';

import { useState } from 'react';
import { ShowCommercial, CommercialDesignation, RecoupmentTrend } from '@/lib/data';
import RecoupmentProgressBar from './RecoupmentProgressBar';

interface BizBuzzCardProps {
  commercial: ShowCommercial;
  showTitle: string;
  trend?: RecoupmentTrend;
  weeklyGross?: number | null;
  showStatus?: 'open' | 'closed' | 'previews';
}

function formatCurrency(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return `$${value.toLocaleString()}`;
}

function formatWithEstimate(formatted: string, isEstimate: boolean): string {
  return isEstimate ? `~${formatted}` : formatted;
}

function formatWeeksToRecoup(weeks: number | null): string {
  if (weeks === null) return '';
  if (weeks < 52) {
    return `${weeks} weeks`;
  }
  const years = (weeks / 52).toFixed(1);
  return `~${years} years`;
}

// Designation badge styling
function getDesignationStyle(designation: CommercialDesignation): {
  bgClass: string;
  textClass: string;
  borderClass: string;
  icon: string;
  description: string;
} {
  switch (designation) {
    case 'Miracle':
      return {
        bgClass: 'bg-gradient-to-r from-amber-500/20 to-yellow-500/20',
        textClass: 'text-amber-400',
        borderClass: 'border-amber-500/30',
        icon: '✨',
        description: 'Long-running mega-hit -- extraordinary returns',
      };
    case 'Windfall':
      return {
        bgClass: 'bg-emerald-500/15',
        textClass: 'text-emerald-400',
        borderClass: 'border-emerald-500/25',
        icon: '💰',
        description: 'Solid hit -- recouped and profitable',
      };
    case 'Trickle':
      return {
        bgClass: 'bg-blue-500/15',
        textClass: 'text-blue-400',
        borderClass: 'border-blue-500/25',
        icon: '💧',
        description: 'Broke even or modest profit',
      };
    case 'Easy Winner':
      return {
        bgClass: 'bg-pink-500/15',
        textClass: 'text-pink-400',
        borderClass: 'border-pink-500/25',
        icon: '🎁',
        description: 'Limited run that made money, limited downside, limited upside',
      };
    case 'Fizzle':
      return {
        bgClass: 'bg-orange-500/15',
        textClass: 'text-orange-400',
        borderClass: 'border-orange-500/25',
        icon: '📉',
        description: 'Closed without recouping (~30%+ recovered)',
      };
    case 'Flop':
      return {
        bgClass: 'bg-red-500/15',
        textClass: 'text-red-400',
        borderClass: 'border-red-500/25',
        icon: '💸',
        description: 'Closed without recouping (~<30% recovered)',
      };
    case 'Nonprofit':
      return {
        bgClass: 'bg-purple-500/15',
        textClass: 'text-purple-400',
        borderClass: 'border-purple-500/25',
        icon: '🎭',
        description: 'Nonprofit theater production',
      };
    case 'Tour Stop':
      return {
        bgClass: 'bg-slate-500/15',
        textClass: 'text-slate-400',
        borderClass: 'border-slate-500/25',
        icon: '🚌',
        description: 'National tour engagement on Broadway',
      };
    case 'TBD':
    default:
      return {
        bgClass: 'bg-gray-500/15',
        textClass: 'text-gray-400',
        borderClass: 'border-gray-500/25',
        icon: '⏳',
        description: 'Too early to determine',
      };
  }
}

function RecoupmentBadge({ recouped }: { recouped: boolean | null }) {
  if (recouped === true) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
        Recouped
      </span>
    );
  }
  if (recouped === false) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-orange-500/15 text-orange-400 border border-orange-500/25">
        Not Recouped
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/15 text-gray-400 border border-gray-500/25">
      Unknown
    </span>
  );
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

// Trend indicator component
function TrendIndicator({ trend }: { trend: RecoupmentTrend }) {
  if (trend === 'unknown') return null;

  const config = {
    improving: {
      icon: '↑',
      label: 'Trending Up',
      colorClass: 'text-emerald-400',
      bgClass: 'bg-emerald-500/15',
      borderClass: 'border-emerald-500/25',
    },
    steady: {
      icon: '→',
      label: 'Steady',
      colorClass: 'text-gray-400',
      bgClass: 'bg-gray-500/15',
      borderClass: 'border-gray-500/25',
    },
    declining: {
      icon: '↓',
      label: 'Trending Down',
      colorClass: 'text-red-400',
      bgClass: 'bg-red-500/15',
      borderClass: 'border-red-500/25',
    },
  }[trend];

  if (!config) return null;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${config.bgClass} ${config.colorClass} border ${config.borderClass}`}>
      <span className="text-sm">{config.icon}</span>
      {config.label}
    </span>
  );
}

// Calculate estimated returns since recoupment
function calculateEstimatedReturns(
  recouped: boolean | null,
  recoupedWeeks: number | null,
  weeklyGross: number | null,
  weeklyRunningCost: number | null,
  capitalization: number | null,
  showStatus: 'open' | 'closed' | 'previews' | undefined
): { yearsOfReturns: number; percentageReturn: number } | null {
  // Only for recouped shows still running
  if (!recouped || !recoupedWeeks || showStatus !== 'open') return null;
  if (!weeklyGross || !weeklyRunningCost || !capitalization) return null;

  // Estimate weekly profit
  const weeklyProfit = weeklyGross - weeklyRunningCost;
  if (weeklyProfit <= 0) return null;

  // Rough estimate: weeks running since recoupment * weekly profit
  // Assuming the show is currently at week = recoupedWeeks + time since
  // We don't have exact weeks running, so use a rough estimate
  const weeksOfProfitEstimate = 52; // Use 1 year as a rough running estimate post-recoupment
  const estimatedTotalReturns = weeklyProfit * weeksOfProfitEstimate;
  const percentageReturn = Math.round((estimatedTotalReturns / capitalization) * 100);

  return {
    yearsOfReturns: 1, // Simplified to 1 year estimate
    percentageReturn,
  };
}

export default function BizBuzzCard({ commercial, showTitle, trend, weeklyGross, showStatus }: BizBuzzCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const style = getDesignationStyle(commercial.designation);

  // Don't render if we have no useful data
  const hasData = commercial.capitalization || commercial.recouped !== null || commercial.designation !== 'TBD';
  if (!hasData) return null;

  // Calculate estimated returns for recouped shows
  const estimatedReturns = calculateEstimatedReturns(
    commercial.recouped,
    commercial.recoupedWeeks,
    weeklyGross ?? null,
    commercial.weeklyRunningCost,
    commercial.capitalization,
    showStatus
  );

  // Show trend for TBD shows that aren't recouped
  const showTrend = trend && trend !== 'unknown' && commercial.designation === 'TBD' && !commercial.recouped;

  return (
    <div className="card p-5 sm:p-6 mb-8">
      <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-4">
        Commercial Scorecard
      </h2>

      {/* Main Content */}
      <div className="space-y-4">
        {/* Top Row: Designation Badge + Recoupment + Trend */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Designation Badge */}
          <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg ${style.bgClass} ${style.textClass} border ${style.borderClass}`}>
            <span className="text-base">{style.icon}</span>
            <span className="font-bold text-sm">{commercial.designation}</span>
          </div>

          {/* Recoupment Badge */}
          <RecoupmentBadge recouped={commercial.recouped} />

          {/* Trend Indicator for TBD shows */}
          {showTrend && <TrendIndicator trend={trend} />}
        </div>

        {/* Stats Row */}
        <div className="flex gap-2 sm:gap-3">
          {/* Capitalization */}
          <div className="flex-1 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
            <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
              {formatWithEstimate(formatCurrency(commercial.capitalization), commercial.isEstimate?.capitalization ?? false)}
            </div>
            <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
              Capitalization
            </div>
          </div>

          {/* Weekly Running Cost (if available) */}
          {commercial.weeklyRunningCost && (
            <div className="flex-1 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
              <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
                {formatWithEstimate(formatCurrency(commercial.weeklyRunningCost), commercial.isEstimate?.weeklyRunningCost ?? false)}
              </div>
              <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
                Weekly Cost
              </div>
            </div>
          )}

          {/* Time to Recoup (if recouped) */}
          {commercial.recouped && commercial.recoupedWeeks && (
            <div className="flex-1 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
              <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-emerald-400 tracking-tight">
                {formatWeeksToRecoup(commercial.recoupedWeeks)}
              </div>
              <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
                To Recoup
              </div>
            </div>
          )}
        </div>

        {/* Recoupment Progress (for shows with estimates) */}
        {commercial.estimatedRecoupmentPct && (
          <RecoupmentProgressBar
            estimatedPct={commercial.estimatedRecoupmentPct}
            source={commercial.estimatedRecoupmentSource}
          />
        )}

        {/* ROI Indicator (for recouped shows still running) */}
        {estimatedReturns && (
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <div className="flex items-center gap-2">
              <span className="text-emerald-400 text-sm">📈</span>
              <span className="text-sm text-emerald-400 font-medium">
                Generating ~{estimatedReturns.percentageReturn}% annual return on investment
              </span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Based on current weekly gross vs running costs
            </p>
          </div>
        )}

        {/* Source Attribution (visible without expanding) */}
        {commercial.capitalizationSource && !commercial.notes && (
          <p className="text-xs text-gray-500">
            Source: {commercial.capitalizationSource}
          </p>
        )}

        {/* Expandable Details */}
        {commercial.notes && (
          <div>
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-300 transition-colors"
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
              {isExpanded ? 'Hide details' : 'Show details'}
            </button>

            {isExpanded && (
              <div className="mt-3 p-3 rounded-lg bg-surface-overlay border border-white/5">
                <p className="text-sm text-gray-400 leading-relaxed">
                  {commercial.notes}
                </p>
                {commercial.capitalizationSource && (
                  <p className="text-xs text-gray-600 mt-2">
                    Source: {commercial.capitalizationSource}
                  </p>
                )}
                {commercial.recoupedDate && (
                  <p className="text-xs text-gray-600 mt-1">
                    Recouped: {commercial.recoupedDate}
                  </p>
                )}
                {commercial.weeklyRunningCostSource && (
                  <p className="text-xs text-gray-600 mt-1">
                    Weekly cost source: {commercial.weeklyRunningCostSource}
                  </p>
                )}
                {commercial.estimatedRecoupmentSource && (
                  <p className="text-xs text-gray-600 mt-1">
                    Recoupment estimate source: {commercial.estimatedRecoupmentSource}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Designation Description */}
      <div className="mt-4 pt-3 border-t border-white/5">
        <p className="text-xs text-gray-500">
          <span className={style.textClass}>{commercial.designation}</span>: {style.description}
        </p>
      </div>
    </div>
  );
}
