'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ShowCommercial, RecoupmentTrend } from '@/lib/data-types';
import { getTrendColor, getTrendIcon } from '@/config/commercial';
import {
  getRecoupmentDisplayMode,
  meetsModelQualityFloor,
  getBreakEven,
  getRecoupmentAttribution,
  getDesignationDisplay,
  publicSourceText,
  isEstimatedRunningCost,
  isEstimatedCapitalization,
  getWeeklyCostSourceLabel,
  getNonprofitProducerLine,
} from '@/lib/commercial-display';
import { formatCapitalization } from '@/lib/biz-format';
import { isRunningStatus } from '@/lib/commercial-metrics';
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
      Not reported
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

// Trend indicator component (4-week average gross vs the prior 4 weeks)
function TrendIndicator({ trend }: { trend: RecoupmentTrend }) {
  if (trend === 'unknown') return null;

  const colorClass = getTrendColor(trend, false);
  const icon = getTrendIcon(trend, false);
  const labels: Record<string, string> = {
    improving: 'Grosses up',
    steady: 'Grosses steady',
    declining: 'Grosses down',
  };
  const bgBorderMap: Record<string, { bgClass: string; borderClass: string }> = {
    improving: { bgClass: 'bg-emerald-500/15', borderClass: 'border-emerald-500/25' },
    steady: { bgClass: 'bg-gray-500/15', borderClass: 'border-white/10' },
    declining: { bgClass: 'bg-red-500/15', borderClass: 'border-red-500/25' },
  };
  const { bgClass, borderClass } = bgBorderMap[trend] || { bgClass: 'bg-gray-500/15', borderClass: 'border-white/10' };

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${bgClass} ${colorClass} border ${borderClass}`}
      title="Last 4 weeks' average gross vs the 4 weeks before"
    >
      <span className="text-sm">{icon}</span>
      {labels[trend] || trend}
    </span>
  );
}

export default function BizBuzzCard({ commercial, showTitle, trend, weeklyGross, showStatus, allTimeGross }: BizBuzzCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  void showTitle;

  // Don't render if we have no useful data
  const hasData = commercial.capitalization || commercial.recouped !== null || commercial.designation !== 'TBD';
  if (!hasData) return null;

  // Closed + TBD reads "Undisclosed" (display only; the record keeps TBD).
  const designation = getDesignationDisplay(commercial.designation, showStatus);
  const running = isRunningStatus(showStatus);
  const producerLine = getNonprofitProducerLine(commercial);
  const isNonprofit = commercial.designation === 'Nonprofit';

  // Display rules (src/lib/commercial-display.ts, unit-tested):
  //  - recouped:true → the recoupment record, never the model (Q1).
  //  - closed show with a final designation → designation + cited facts only:
  //    no model %, range, break-even or model confidence (BRO-4623 P0-4).
  //  - otherwise model output above the quality floor, labelled as an estimate.
  const displayMode = getRecoupmentDisplayMode({ ...commercial, status: showStatus });
  const attribution = displayMode === 'announced' ? getRecoupmentAttribution(commercial) : null;

  // Source lines print only publishable text: records can carry internal
  // research notes ("GPT DR Batch 3...", "deep research synthesis"), which
  // publicSourceText drops. Estimated weekly costs read "Estimate".
  const capSourceText = publicSourceText(commercial.capitalizationSource);
  const weeklyCostSourceText = commercial.weeklyRunningCost ? getWeeklyCostSourceLabel(commercial) : null;
  const notesText = publicSourceText(commercial.notes);
  const hasDetails = !!(notesText || capSourceText || weeklyCostSourceText);

  // Trend only for running, unrecouped shows still waiting on an outcome.
  const showTrend = !!trend && trend !== 'unknown' && running && commercial.designation === 'TBD' && !commercial.recouped;

  // One break-even figure everywhere (show card and /biz at-risk list):
  // model break-even above the quality floor, else the recorded weekly cost.
  const breakEven = displayMode === 'model' ? getBreakEven(commercial) : null;
  const breakEvenIsModel =
    breakEven != null && breakEven === commercial.modelBreakeven && meetsModelQualityFloor(commercial);

  const breakevenComparison =
    breakEven && weeklyGross != null && running
      ? { gross: weeklyGross, breakeven: breakEven, above: weeklyGross >= breakEven }
      : null;

  // Confidence label: the recoupment record's sourcing for recouped shows;
  // the model's own data-quality grade for model estimates; none otherwise.
  const confidence: { level: 'high' | 'medium' | 'low'; label: string; basis: string } | null =
    attribution
      ? attribution.confidence
      : displayMode === 'model'
        ? {
            level: commercial.modelDataQuality === 'high' ? 'high' : commercial.modelDataQuality === 'low' ? 'low' : 'medium',
            label: `${commercial.modelDataQuality === 'high' ? 'High' : commercial.modelDataQuality === 'low' ? 'Low' : 'Medium'} confidence`,
            basis: 'Scorecard commercial model (estimate)',
          }
        : null;
  const confidenceStyles: Record<'high' | 'medium' | 'low', { text: string; dot: string }> = {
    high: { text: 'text-emerald-400', dot: 'bg-emerald-400' },
    medium: { text: 'text-brand', dot: 'bg-brand' },
    low: { text: 'text-orange-400', dot: 'bg-orange-400' },
  };

  return (
    <section className="card p-5 sm:p-6 pb-4 sm:pb-5 mb-5 sm:mb-8" aria-labelledby="commercial-scorecard-heading">
      {/* Unified scorecard chrome: eyebrow on left, source attribution right */}
      <header className="flex items-center justify-between gap-3 mb-1">
        <h2 id="commercial-scorecard-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">
          Commercial Scorecard
        </h2>
        <span className="text-[10px] tracking-[0.06em] text-gray-500 italic shrink-0">
          {displayMode === 'model' ? 'source · filings, press + our model' : 'source · filings + press'}
        </span>
      </header>
      <p className="text-[11px] font-medium tracking-[0.06em] text-gray-500 italic m-0 mb-3">
        ~ marks an estimate ·{' '}
        <Link href="/methodology#commercial" className="underline hover:text-gray-300">
          how we measure
        </Link>
      </p>

      {/* Status chips: recoupment, trend, break-even position */}
      <div className="flex flex-wrap gap-1.5 mb-4 empty:hidden">
        {/* Nonprofits raise no investor capital: "Not reported" / "Not Recouped" would read as a gap or a failure. */}
        {!(isNonprofit && commercial.recouped !== true) && <RecoupmentBadge recouped={commercial.recouped} />}
        {showTrend && <TrendIndicator trend={trend} />}
        {breakevenComparison && (
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
              breakevenComparison.above
                ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25'
                : 'bg-orange-500/15 text-orange-400 border-orange-500/25'
            }`}
          >
            {breakevenComparison.above ? 'Above est. break-even' : '⚠ Under est. break-even'}
          </span>
        )}
      </div>

      {/* Main Content */}
      <div className="space-y-4">
        {/* Designation hero */}
        <div>
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-2xl leading-none" aria-hidden="true">{designation.icon}</span>
            <span className={`font-extrabold text-xl sm:text-[1.375rem] uppercase tracking-[0.04em] leading-[1.15] ${designation.textClass}`}>
              {designation.label}
            </span>
          </div>
          {/* A Nonprofit show names its company instead of the generic "(LCT, Roundabout, etc.)". */}
          <p className="text-[13px] text-gray-400 mt-1.5 leading-[1.4]">
            {isNonprofit && producerLine ? producerLine : designation.description}
          </p>
          {producerLine && !isNonprofit && (
            <p className="text-[13px] text-gray-300 mt-0.5 leading-[1.4]" data-testid="nonprofit-producer">
              {producerLine}
            </p>
          )}
        </div>

        {/* Divider between hero and stat tiles */}
        <div className="h-px bg-white/5" aria-hidden="true" />

        {/* Stats Row */}
        <div className="flex flex-wrap gap-2 sm:gap-3">
          {/* Capitalization */}
          <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
            <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
              {commercial.capitalization == null
                ? 'Undisclosed'
                : formatCapitalization(commercial.capitalization, isEstimatedCapitalization(commercial))}
            </div>
            <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
              Capitalization
            </div>
          </div>

          {/* Weekly Running Cost (if available) */}
          {commercial.weeklyRunningCost && (
            <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
              <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
                {formatWithEstimate(formatCurrency(commercial.weeklyRunningCost), isEstimatedRunningCost(commercial))}
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

          {/* Model break-even: only with a model estimate on screen, and
              redundant when the break-even comparison below shows it */}
          {breakEvenIsModel && !breakevenComparison && (
            <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
              <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-gray-300 tracking-tight">
                ~{formatCurrency(breakEven)}
              </div>
              <div className="text-[10px] sm:text-xs text-gray-500 uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
                Est. Break-even
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

        {/* Recoupment record: neutral wording plus its source; the model is
            never quoted on these shows (Q1 sign-off) */}
        {attribution && (
          <div
            className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20"
            data-testid="recoupment-announcement"
          >
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              <span className="text-sm text-emerald-400 font-medium">
                {attribution.headline}
                {attribution.qualifier ? ` · ${attribution.qualifier}` : ''}
              </span>
            </div>
            {attribution.sourceText && (
              <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                Source:{' '}
                {attribution.sourceUrl ? (
                  <a
                    href={attribution.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-gray-300"
                  >
                    {attribution.sourceText}
                  </a>
                ) : (
                  attribution.sourceText
                )}
              </p>
            )}
          </div>
        )}

        {/* Recoupment estimate: model output only, above the quality floor,
            never on a recouped show or a closed show with a final outcome. */}
        {displayMode === 'model' && commercial.modelRecoupmentPct && (
          <RecoupmentProgressBar
            estimatedPct={commercial.modelRecoupmentPct}
            modelMethod={commercial.modelMethod}
            variant="headline"
          />
        )}

        {/* Latest week's gross vs estimated break-even */}
        {breakevenComparison && (
          <div className="bg-surface-overlay rounded-lg sm:rounded-xl border border-white/5 px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3 mb-1.5 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-gray-500">
                Latest week vs break-even
              </span>
              <span className="text-xs text-gray-300 tabular-nums">
                <span className={`font-semibold ${breakevenComparison.above ? 'text-emerald-400' : 'text-red-400'}`}>
                  {formatCurrency(breakevenComparison.gross)}
                </span>{' '}
                gross · <span className="text-gray-400">~{formatCurrency(breakevenComparison.breakeven)}</span> est. break-even
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

        {/* Source Attribution (visible without expanding) */}
        {capSourceText && !hasDetails && (
          <p className="text-xs text-gray-500">
            Source: {capSourceText}
          </p>
        )}

        {/* Expandable Details */}
        {hasDetails && (
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
                {notesText && (
                  <p className="text-sm text-gray-400 leading-relaxed mb-2">
                    {notesText}
                  </p>
                )}
                {/* The recoupment date and source print once, in the attribution block above. */}
                {capSourceText && (
                  <p className="text-xs text-gray-500">
                    Capitalization source: {capSourceText}
                  </p>
                )}
                {weeklyCostSourceText && (
                  <p className="text-xs text-gray-500 mt-1">
                    Weekly cost source: {weeklyCostSourceText}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
        {/* Confidence label: how firmly to read the recoupment line above */}
        {confidence && (
          <div className="flex items-center justify-between gap-3 pt-2.5 border-t border-white/5">
            <span className={`inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] ${confidenceStyles[confidence.level].text}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${confidenceStyles[confidence.level].dot}`} aria-hidden="true" />
              {confidence.label}
            </span>
            {/* The recoupment headline already prints the qualifier ("Not publicly announced"). */}
            {confidence.basis !== attribution?.qualifier && (
              <span className="text-[11px] text-gray-500 italic text-right">{confidence.basis}</span>
            )}
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
