'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { ShowCommercial, RecoupmentTrend } from '@/lib/data-types';
import { getTrendColor, getTrendIcon } from '@/config/commercial';
import {
  getRecoupmentDisplayMode,
  getReportedReturnLine,
  getEstimatedReturnRange,
  getModelHoldLabel,
  meetsModelQualityFloor,
  getBreakEven,
  getRecoupmentAttribution,
  getDesignationDisplay,
  publicSourceText,
  sourceTextSegments,
  sourceTextLink,
  isEstimatedRunningCost,
  isEstimatedCapitalization,
  isMaximumCapitalization,
  getWeeklyCostSourceLabel,
  getNonprofitProducerLine,
  getConversionSourceLabel,
  hasCommercialCard,
  lossBasisCaveat,
  lossCanChangeNote,
  LIKELY_OUTCOME_BASIS,
  publicNotesText,
  getDisplayableEstimateRange,
  hasNoInvestorsToRepay,
} from '@/lib/commercial-display';
import { formatCapitalization, weeklyCostLabel } from '@/lib/biz-format';
import { isRunningStatus } from '@/lib/commercial-metrics';
import { returnSnapshotLabel } from '../../scripts/lib/commercial-return-snapshot';
import { ourRecoupRangePct } from '../../scripts/lib/our-recoup-estimate';
import RecoupmentProgressBar from './RecoupmentProgressBar';
import AnalystEstimateCredit from './biz/AnalystEstimateCredit';
import EstimatedReturnLine from './biz/EstimatedReturnLine';
import MoneyGate from './biz/MoneyGate';
import dynamic from 'next/dynamic';
import type { BoxOfficeV2Card } from '@/lib/box-office-v2-display';

// BRO-5007 v3: unreleased. Its own chunk, fetched only when the section
// renders; flag-off builds drop the import (HELD_BOX_OFFICE_BUILD, next.config.js).
const BreakEvenSection = process.env.HELD_BOX_OFFICE_BUILD === 'true'
  ? dynamic(() => import('@/components/biz/BreakEvenSection'))
  : () => null;

interface BizBuzzCardProps {
  commercial: ShowCommercial;
  showTitle: string;
  trend?: RecoupmentTrend;
  weeklyGross?: number | null;
  showStatus?: 'open' | 'closed' | 'previews' | 'upcoming';
  /** Show closing date (YYYY-MM-DD): lets a recoup report month after closing read "reported" (BRO-5779). */
  closingDate?: string | null;
  allTimeGross?: number | null;
  /** BRO-5007 v3 break-even section (unreleased): null unless commercial && boxOfficeV2 and it has something to show. */
  breakEvenCard?: BoxOfficeV2Card | null;
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '–';
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

// A source line with any cited URL shown as a short link (its host name),
// not a raw URL clipped at the card's edge (BRO-5520).
function SourceText({ text }: { text: string }) {
  return (
    <>
      {sourceTextSegments(text).map((seg, i) =>
        seg.kind === 'link' ? (
          <a key={i} href={seg.href} target="_blank" rel="noopener noreferrer" className="underline hover:text-gray-300">
            {seg.label}
            <span className="sr-only">, the cited source (opens in a new tab)</span>
          </a>
        ) : (
          seg.text
        )
      )}
    </>
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

export default function BizBuzzCard({ commercial, showTitle, trend, weeklyGross, showStatus, allTimeGross, breakEvenCard = null, closingDate }: BizBuzzCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  void showTitle;

  // Don't render if we have no useful data
  if (!hasCommercialCard(commercial)) return null;

  // Closed + TBD reads "Undisclosed" (display only; the record keeps TBD).
  const designation = getDesignationDisplay(commercial.designation, showStatus, commercial.recouped);
  const running = isRunningStatus(showStatus);
  const snapshotLabel = returnSnapshotLabel(commercial, { status: showStatus, closingDate });
  const producerLine = getNonprofitProducerLine(commercial);
  const isNonprofit = commercial.designation === 'Nonprofit';
  const lossCaveat = lossBasisCaveat(commercial);
  const lossCanChange = lossCanChangeNote(commercial);

  // Display rules (src/lib/commercial-display.ts, unit-tested):
  //  - recouped:true → the recoupment record, never an estimate (Q1).
  //  - a closed show's trade-reported return beats every estimate (BRO-5313).
  //  - the analyst's published estimate, then our model above the quality
  //    floor, each labelled; a closed Fizzle/Flop only shows one that agrees
  //    with its label (BRO-4623 P0-4, BRO-5502).
  const displayMode = getRecoupmentDisplayMode({ ...commercial, status: showStatus });
  // A model the display guard held back says why instead of vanishing (BRO-4989).
  const holdLabel = displayMode === 'none' ? getModelHoldLabel({ ...commercial, status: showStatus }) : null;
  const reportedReturnLine = getReportedReturnLine({ ...commercial, status: showStatus });
  const estimatedReturnRange = !reportedReturnLine ? getEstimatedReturnRange(commercial, showStatus) : null;
  const estimateRange = displayMode === 'analyst' && !reportedReturnLine ? getDisplayableEstimateRange({ ...commercial, status: showStatus }) : null;
  const analystRange = estimateRange?.range ?? null;
  const showModelBar = displayMode === 'model' && !reportedReturnLine;
  const attribution = displayMode === 'announced' ? getRecoupmentAttribution(commercial, closingDate) : null;
  // One link with no raw URL text: the line is clamped to two lines (BRO-5520).
  const attributionLink = attribution?.sourceText ? sourceTextLink(attribution.sourceText, attribution.sourceUrl) : null;

  // Source lines print only publishable text: records can carry internal
  // research notes ("GPT DR Batch 3...", "deep research synthesis"), which
  // publicSourceText drops. Estimated weekly costs read "Estimate".
  const capSourceText = publicSourceText(commercial.capitalizationSource);
  const weeklyCostSourceText = commercial.weeklyRunningCost ? getWeeklyCostSourceLabel(commercial) : null;
  const notesText = publicNotesText(commercial);
  const hasDetails = !!(notesText || capSourceText || weeklyCostSourceText);

  // Trend only for running, unrecouped shows still waiting on an outcome.
  // The v3 break-even section covers the trend, so its chip goes when the section shows.
  const showTrend = !breakEvenCard && !!trend && trend !== 'unknown' && running && commercial.designation === 'TBD' && !commercial.recouped;

  // One break-even figure everywhere (show card and /biz at-risk list):
  // model break-even above the quality floor, else the recorded weekly cost.
  const breakEven = showModelBar ? getBreakEven(commercial) : null;
  const breakEvenIsModel =
    breakEven != null && breakEven === commercial.modelBreakeven && meetsModelQualityFloor(commercial);

  const breakevenComparison =
    // One week against break-even: replaced by the v3 section's four-week view when it shows.
    !breakEvenCard && breakEven && weeklyGross != null && running
      ? { gross: weeklyGross, breakeven: breakEven, above: weeklyGross >= breakEven }
      : null;

  // Confidence label: the recoupment record's sourcing for recouped shows;
  // the model's own data-quality grade for model estimates; none otherwise.
  const confidence: { level: 'high' | 'medium' | 'low'; label: string; basis: string } | null =
    attribution
      ? attribution.confidence
      : showModelBar
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
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mb-1">
        <h2 id="commercial-scorecard-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">
          Profitability Scorecard
        </h2>
        <span className="text-[10px] tracking-[0.06em] text-fg-muted italic shrink-0">
          {showModelBar || estimatedReturnRange ? 'source · filings, press + our model' : estimateRange?.withModel ? (commercial.analystRecoupPct ? 'source · filings, press, analyst estimate + our model' : 'source · filings, press + our model') : analystRange ? (commercial.analystRecoupPct ? 'source · filings, press + analyst estimate' : 'source · filings, press + our estimate') : 'source · filings + press'}
        </span>
      </header>
      <p className="text-[11px] font-medium tracking-[0.06em] text-fg-muted italic m-0 mb-3">
        ~ marks an estimate ·{' '}
        <Link href="/methodology#commercial" className="underline hover:text-gray-300">
          how we measure
        </Link>
      </p>

      {/* Everything below the heading is free with an email (BRO-6210). */}
      {/* No paywall JSON-LD here: it would mark the whole show page not free
          for one small section (BRO-6210 review). /biz pages carry it. */}
      <MoneyGate page="show-page" preview="short" schema={false}>
      {/* Status chips: recoupment, trend, break-even position */}
      <div className="flex flex-wrap gap-1.5 mb-4 empty:hidden">
        {/* Pure nonprofits raise no investor capital: "Not reported" / "Not Recouped" would read as a gap or a failure.
            An enhancement deal has investors to repay, so it keeps the badge (BRO-5502). */}
        {!(hasNoInvestorsToRepay(commercial) && commercial.recouped !== true) && <RecoupmentBadge recouped={commercial.recouped} />}
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
            {snapshotLabel && <span className="text-xs text-gray-400" data-testid="return-snapshot-date">{snapshotLabel}</span>}
          </div>
          {/* A Nonprofit show names its company instead of the generic "(LCT, Roundabout, etc.)". */}
          {/* Owner policy B (BRO-5020): a loss label resting on silence says so,
              in place of the generic description (which claims a return range
              no source reported). */}
          {!lossCaveat && (
            <p className="text-[13px] text-gray-400 mt-1.5 leading-[1.4]">
              {isNonprofit && producerLine ? producerLine : designation.description}
            </p>
          )}
          {lossCaveat && (
            <p className="text-[13px] text-gray-400 mt-1.5 leading-[1.4]" data-testid="loss-basis-caveat">
              {lossCaveat}
            </p>
          )}
          {/* Our best guess at how it did where no source says, marked with what it rests on (BRO-5647). */}
          {commercial.likelyOutcome && (
            <p className="text-[13px] text-gray-300 mt-1.5 leading-[1.4]" data-testid="likely-outcome">
              <span className="font-semibold">{commercial.likelyOutcome}</span>
              <span className="text-xs text-fg-muted">{` · ${LIKELY_OUTCOME_BASIS[commercial.likelyOutcomeBasis ?? 'model']}`}</span>
            </p>
          )}
          {reportedReturnLine && (
            <p className="text-[13px] text-gray-300 mt-1.5 leading-[1.4]" data-testid="reported-return">
              {reportedReturnLine}
            </p>
          )}
          <EstimatedReturnLine range={estimatedReturnRange} modelDataQuality={commercial.modelDataQuality} />
          {/* A loss label describes the show as it closed; tours and licensing can still pay it back (BRO-5645). */}
          {lossCanChange && (
            <p className="text-xs text-fg-muted mt-1 leading-[1.4]" data-testid="loss-can-change">
              {lossCanChange}
            </p>
          )}
          {producerLine && !isNonprofit && (
            <p className="text-[13px] text-gray-300 mt-0.5 leading-[1.4]" data-testid="nonprofit-producer">
              {producerLine}
              {/* A nonprofit run that became a commercial run cites where that is reported (BRO-5508). */}
              {commercial.commercialConversion?.sourceUrl && (
                <>
                  {' · '}
                  <a href={commercial.commercialConversion.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-white/20 hover:text-brand">
                    {getConversionSourceLabel(commercial.commercialConversion.sourceUrl)}
                    <span className="sr-only">, where the switch to a commercial run is reported (opens in a new tab)</span>
                  </a>
                </>
              )}
            </p>
          )}
        </div>

        {/* Divider between hero and stat tiles */}
        <div className="h-px bg-white/5" aria-hidden="true" />

        {/* Stats Row */}
        <div className="flex flex-wrap gap-2 sm:gap-3">
          {/* Capitalization */}
          <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
            {/* "up to $18.0M" runs one step smaller so it stays on one line beside the other tiles (BRO-5660). */}
            <div className={`${isMaximumCapitalization(commercial) ? 'text-base sm:text-xl lg:text-2xl' : 'text-lg sm:text-2xl lg:text-3xl'} font-extrabold text-white tracking-tight`}>
              {commercial.capitalization == null
                ? 'Undisclosed'
                : formatCapitalization(commercial.capitalization, isEstimatedCapitalization(commercial), isMaximumCapitalization(commercial))}
            </div>
            <div className="text-[10px] sm:text-xs text-fg-muted uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
              Capitalization
            </div>
          </div>

          {/* Weekly Running Cost (if available) */}
          {commercial.weeklyRunningCost && (
            <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
              <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
                {formatWithEstimate(formatCurrency(commercial.weeklyRunningCost), isEstimatedRunningCost(commercial))}
              </div>
              <div className="text-[10px] sm:text-xs text-fg-muted uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
                {weeklyCostLabel(commercial.weeklyRunningCostBasis)}
              </div>
            </div>
          )}

          {/* Time to Recoup (if recouped) */}
          {commercial.recouped && commercial.recoupedWeeks && (
            <div className="flex-1 min-w-[calc(50%-0.25rem)] sm:min-w-0 bg-surface-overlay rounded-lg sm:rounded-xl p-2.5 sm:p-4 text-center border border-white/5">
              <div className="text-lg sm:text-2xl lg:text-3xl font-extrabold text-emerald-400 tracking-tight">
                {formatWeeksToRecoup(commercial.recoupedWeeks)}
              </div>
              <div className="text-[10px] sm:text-xs text-fg-muted uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
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
              <div className="text-[10px] sm:text-xs text-fg-muted uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
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
              <div className="text-[10px] sm:text-xs text-fg-muted uppercase tracking-wide mt-0.5 sm:mt-1 font-medium">
                Total Gross
              </div>
            </div>
          )}
        </div>

        {breakEvenCard && <BreakEvenSection card={breakEvenCard} />}

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
              <p className="text-xs text-fg-muted mt-1 line-clamp-2">
                Source:{' '}
                {attributionLink?.href ? (
                  <a
                    href={attributionLink.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:text-gray-300"
                  >
                    {attributionLink.label}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  attributionLink?.label
                )}
              </p>
            )}
          </div>
        )}

        {/* Recoupment estimate: the analyst's published range, else our model
            above the quality floor; never on a recouped show, never beside a
            reported return or a closed label it contradicts. */}
        {analystRange && (
          <div>
            {analystRange[0] >= 100 ? (
              <p className="text-sm text-gray-300">{ourRecoupRangePct(commercial) ? 'Est. recouped, not yet announced' : 'Estimated to have recouped, not yet announced'}</p>
            ) : (
              <RecoupmentProgressBar estimatedPct={analystRange} variant="headline" />
            )}
            <div className="mt-1">
              <AnalystEstimateCredit asOf={commercial.analystRecoupAsOf} url={commercial.analystRecoupUrl} withModel={estimateRange?.withModel} ours={!!ourRecoupRangePct(commercial) || !commercial.analystRecoupPct} />
            </div>
          </div>
        )}
        {showModelBar && commercial.modelRecoupmentPct && (
          <RecoupmentProgressBar
            estimatedPct={commercial.modelRecoupmentPct}
            modelMethod={commercial.modelMethod}
            belowCosts={commercial.modelBelowCosts}
            final={showStatus === 'closed'}
            variant="headline"
          />
        )}
        {showModelBar && commercial.modelRecoupmentPct && isMaximumCapitalization(commercial) && (
          // The model's % is of the capitalization; a ceiling overstates the
          // denominator when the raise came in lower (BRO-5660).
          <p className="text-xs text-gray-400" data-testid="model-against-maximum">
            Measured against the {formatCurrency(commercial.capitalization)} maximum offering; the amount raised may be lower.
          </p>
        )}
        {showModelBar && commercial.modelRecoupmentPct && commercial.estimatedInputs?.length ? (
          <p className="text-xs text-gray-400" data-testid="model-estimated-inputs">
            This estimate rests on guesses: {commercial.estimatedInputs.join('; ')}. They are not disclosed figures.
          </p>
        ) : null}
        {holdLabel && (
          <p className="text-xs text-gray-400" data-testid="model-hold">
            Recoupment estimate: {holdLabel}
          </p>
        )}

        {/* Latest week's gross vs estimated break-even */}
        {breakevenComparison && (
          <div className="bg-surface-overlay rounded-lg sm:rounded-xl border border-white/5 px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3 mb-1.5 flex-wrap">
              <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-fg-muted">
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
          <p className="text-xs text-fg-muted break-words">
            Source: <SourceText text={capSourceText} />
          </p>
        )}

        {/* Expandable Details */}
        {hasDetails && (
          <div>
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors"
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
                  <p className="text-xs text-fg-muted break-words">
                    Capitalization source: <SourceText text={capSourceText} />
                  </p>
                )}
                {weeklyCostSourceText && (
                  <p className="text-xs text-fg-muted mt-1 break-words">
                    Weekly cost source: <SourceText text={weeklyCostSourceText} />
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
              <span className="text-[11px] text-fg-muted italic text-right">{confidence.basis}</span>
            )}
          </div>
        )}
      </div>

      </MoneyGate>

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
