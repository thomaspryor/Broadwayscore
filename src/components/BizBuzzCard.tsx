'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ShowCommercial, RecoupmentTrend } from '@/lib/data-types';
import { getDesignationBadgeStyle, getTrendColor, getTrendIcon } from '@/config/commercial';
import {
  getRecoupmentDisplayMode,
  meetsModelQualityFloor,
  isEditorialRecoupment,
  formatRecoupedDate,
} from '@/lib/commercial-display';
import RecoupmentProgressBar from './RecoupmentProgressBar';

interface BizBuzzCardProps {
  commercial: ShowCommercial;
  showTitle: string;
  trend?: RecoupmentTrend;
  weeklyGross?: number | null;
  showStatus?: 'open' | 'closed' | 'previews' | 'upcoming';
  allTimeGross?: number | null;
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—';
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
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/15 text-gray-400 border border-white/10">
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

  const colorClass = getTrendColor(trend, false);
  const icon = getTrendIcon(trend, false);
  const labels: Record<string, string> = {
    improving: 'Trending Up',
    steady: 'Steady',
    declining: 'Trending Down',
  };
  // Derive bg/border from trend color pattern
  const bgBorderMap: Record<string, { bgClass: string; borderClass: string }> = {
    improving: { bgClass: 'bg-emerald-500/15', borderClass: 'border-emerald-500/25' },
    steady: { bgClass: 'bg-gray-500/15', borderClass: 'border-white/10' },
    declining: { bgClass: 'bg-red-500/15', borderClass: 'border-red-500/25' },
  };
  const { bgClass, borderClass } = bgBorderMap[trend] || { bgClass: 'bg-gray-500/15', borderClass: 'border-white/10' };

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${bgClass} ${colorClass} border ${borderClass}`}>
      <span className="text-sm">{icon}</span>
      {labels[trend] || trend}
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
  showStatus: 'open' | 'closed' | 'previews' | 'upcoming' | undefined
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

export default function BizBuzzCard({ commercial, showTitle, trend, weeklyGross, showStatus, allTimeGross }: BizBuzzCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const style = getDesignationBadgeStyle(commercial.designation);

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

  // Q1 conflict rule + quality floor (see src/lib/commercial-display.ts):
  // announced/curated recoupment suppresses ALL model output; model numbers
  // below the quality floor stay off the card.
  const displayMode = getRecoupmentDisplayMode(commercial);
  const modelQualityOk = meetsModelQualityFloor(commercial);
  const recoupedDateLabel = formatRecoupedDate(commercial.recoupedDate);
  const editorialRecoupment = isEditorialRecoupment(commercial);

  // Break-even vs current gross floor (mockup's warning path). Model-derived,
  // so it obeys the same quality floor and never renders on recouped shows.
  const breakevenComparison =
    !commercial.recouped &&
    displayMode === 'model' &&
    modelQualityOk &&
    commercial.modelBreakeven &&
    weeklyGross != null &&
    showStatus === 'open'
      ? { gross: weeklyGross, breakeven: commercial.modelBreakeven, above: weeklyGross >= commercial.modelBreakeven }
      : null;

  // Confidence label: producer announcements are facts; model output inherits
  // the model's own data-quality grade.
  const confidence: { level: 'high' | 'medium' | 'low'; label: string; basis: string } | null =
    displayMode === 'announced'
      ? { level: 'high', label: 'High confidence', basis: editorialRecoupment ? 'Scorecard editorial assessment' : 'Producer announcement' }
      : displayMode === 'model' && modelQualityOk
        ? {
            level: commercial.modelDataQuality === 'high' ? 'high' : commercial.modelDataQuality === 'low' ? 'low' : 'medium',
            label: `${commercial.modelDataQuality === 'high' ? 'High' : commercial.modelDataQuality === 'low' ? 'Low' : 'Medium'} confidence`,
            basis: 'Scorecard commercial model',
          }
        : null;
  const confidenceStyles: Record<'high' | 'medium' | 'low', { text: string; dot: string }> = {
    high: { text: 'text-emerald-400', dot: 'bg-emerald-400' },
    medium: { text: 'text-brand', dot: 'bg-brand' },
    low: { text: 'text-orange-400', dot: 'bg-orange-400' },
  };

  return (
    <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8" aria-labelledby="commercial-scorecard-heading">
      {/* Unified scorecard chrome — eyebrow on left, source attribution right */}
      <header className="flex items-center justify-between gap-3 mb-1">
        <h2 id="commercial-scorecard-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">
          Commercial Scorecard
        </h2>
        <span className="text-[10px] tracking-[0.06em] text-gray-500 italic shrink-0">
          source · modelled + press
        </span>
      </header>
      <p className="text-[11px] font-medium tracking-[0.06em] text-gray-500 lowercase italic m-0 mb-3">
        estimates unless noted
      </p>

      {/* Status chips: recoupment, trend, break-even position */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        <RecoupmentBadge recouped={commercial.recouped} />
        {showTrend && <TrendIndicator trend={trend} />}
        {breakevenComparison && (
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
              breakevenComparison.above
                ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25'
                : 'bg-orange-500/15 text-orange-400 border-orange-500/25'
            }`}
          >
            {breakevenComparison.above ? 'Above break-even' : '⚠ Under break-even'}
          </span>
        )}
      </div>

      {/* Main Content */}
      <div className="space-y-4">
        {/* Designation hero (no outer colored frame — emoji + title supply
            the color, matching the audience card's hero treatment) */}
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-2xl leading-none" aria-hidden="true">{style.icon}</span>
            <span className={`font-extrabold text-xl sm:text-[1.375rem] uppercase tracking-[0.04em] leading-[1.15] ${style.textClass}`}>
              {commercial.designation}
            </span>
          </div>
          <p className="text-[13px] text-gray-400 mt-1.5 leading-[1.4]">
            {style.description}
          </p>
        </div>

        {/* Divider between hero and stat tiles */}
        <div className="h-px bg-white/5" aria-hidden="true" />

        {/* Stats Row */}
        <div className="flex flex-wrap gap-2 sm:gap-3">
          {/* Capitalization */}
          <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
            <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
              {formatWithEstimate(formatCurrency(commercial.capitalization), commercial.isEstimate?.capitalization ?? false)}
            </div>
            <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
              Capitalization
            </div>
          </div>

          {/* Weekly Running Cost (if available) */}
          {commercial.weeklyRunningCost && (
            <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
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
            <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
              <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-emerald-400 tracking-tight">
                {formatWeeksToRecoup(commercial.recoupedWeeks)}
              </div>
              <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
                To Recoup
              </div>
            </div>
          )}

          {/* Weekly Breakeven (from model — hidden below the quality floor;
              redundant when the break-even vs floor bar below shows the same number) */}
          {commercial.modelBreakeven && !commercial.recouped && modelQualityOk && !breakevenComparison && (
            <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
              <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-gray-300 tracking-tight">
                {formatCurrency(commercial.modelBreakeven)}
              </div>
              <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
                Breakeven
              </div>
            </div>
          )}

          {/* Total Box Office Gross (for closed shows without weeks-to-recoup) */}
          {showStatus === 'closed' && allTimeGross && !(commercial.recouped && commercial.recoupedWeeks) && (
            <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
              <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
                {formatCurrency(allTimeGross)}
              </div>
              <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
                Total Gross
              </div>
            </div>
          )}
        </div>

        {/* Announced/curated recoupment — the announcement IS the display;
            the model is never quoted on these shows (Q1 sign-off) */}
        {displayMode === 'announced' && (
          <div
            className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20"
            data-testid="recoupment-announcement"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              <span className="text-sm text-emerald-400 font-medium">
                {editorialRecoupment
                  ? `Recouped${recoupedDateLabel ? ` · ${recoupedDateLabel}` : ''} · Scorecard editorial assessment`
                  : `Producers announced recoupment${recoupedDateLabel ? ` in ${recoupedDateLabel}` : ''}`}
              </span>
            </div>
            {commercial.recoupedSource && (
              <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                Source: {commercial.recoupedSource}
              </p>
            )}
          </div>
        )}

        {/* Recoupment Progress — model output only, and only above the
            quality floor. Renders solely when no announced/curated
            recoupment state exists (Q1). */}
        {displayMode === 'model' && commercial.modelRecoupmentPct && (
          <RecoupmentProgressBar
            estimatedPct={commercial.modelRecoupmentPct}
            modelMethod={commercial.modelMethod}
            variant="headline"
          />
        )}

        {/* Break-even vs current gross floor (mockup warning path) */}
        {breakevenComparison && (
          <div className="bg-surface-overlay rounded-lg sm:rounded-xl border border-white/5 px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3 mb-1.5 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-gray-500">
                Break-even vs floor
              </span>
              <span className="text-xs text-gray-300 tabular-nums">
                <span className={`font-semibold ${breakevenComparison.above ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatCurrency(breakevenComparison.gross)}
                </span>{' '}
                gross · <span className="text-gray-400">{formatCurrency(breakevenComparison.breakeven)}</span> est. break-even
              </span>
            </div>
            <div className="relative w-full bg-white/5 rounded-full h-1.5" aria-hidden="true">
              <div
                className={`h-1.5 rounded-full ${breakevenComparison.above ? 'bg-emerald-500' : 'bg-orange-400'}`}
                style={{ width: `${Math.min(100, Math.round((breakevenComparison.gross / breakevenComparison.breakeven) * 100))}%` }}
              />
            </div>
          </div>
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
                  <p className="text-xs text-gray-500 mt-2">
                    Source: {commercial.capitalizationSource}
                  </p>
                )}
                {commercial.recoupedDate && (
                  <p className="text-xs text-gray-500 mt-1">
                    Recouped: {commercial.recoupedDate}
                  </p>
                )}
                {commercial.recouped === true && commercial.recoupedSource && (
                  <p className="text-xs text-gray-500 mt-1">
                    Recoupment source: {commercial.recoupedSource}
                  </p>
                )}
                {commercial.weeklyRunningCostSource && (
                  <p className="text-xs text-gray-500 mt-1">
                    Weekly cost source: {commercial.weeklyRunningCostSource}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        {/* Confidence label (mockup): how firmly to read the numbers above */}
        {confidence && (
          <div className="flex items-center justify-between gap-3 pt-2.5 border-t border-white/5">
            <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${confidenceStyles[confidence.level].text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${confidenceStyles[confidence.level].dot}`} aria-hidden="true" />
              {confidence.label}
            </span>
            <span className="text-[11px] text-gray-500 italic text-right">{confidence.basis}</span>
          </div>
        )}
      </div>

      {/* Footer link to the cross-show commercial leaderboard */}
      <div className="mt-1.5 -mb-1 sm:-mb-2">
        <Link
          href="/biz"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-hover transition-colors group"
        >
          <span>See all commercial scores</span>
          <span className="inline-block transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );
}
