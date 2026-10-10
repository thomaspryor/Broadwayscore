// Pure calculation helpers for the commercial scorecard (/biz, season pages,
// show-page Commercial Scorecard). No data imports: data-commercial.ts feeds
// these from commercial.json / grosses-history.json, and the unit tests
// (tests/unit/commercial-metrics.test.ts) call them with fixtures.

import type { RecoupmentTrend } from '@/config/commercial';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parseIsoDay(date: string | null | undefined): Date | null {
  if (!date) return null;
  const d = new Date(date);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Weeks from opening night to the reported recoupment month.
 *
 * recoupedDate is "YYYY-MM" or "YYYY". Method:
 *  - "YYYY-MM": the 15th of that month (mid-month), never later than the
 *    closing date or today.
 *  - "YYYY" only: null. A year alone cannot place the date within ~52 weeks
 *    (Dec 31 made Lion King "~111 weeks" and Ragtime "~63 weeks").
 *  - null when the recoupment month starts after the closing date or after
 *    today (a data error, not a number to publish), or precedes opening.
 */
export function calculateWeeksToRecoup(
  openingDate: string | null | undefined,
  recoupedDate: string | null | undefined,
  closingDate?: string | null,
  now: Date = new Date(),
): number | null {
  const open = parseIsoDay(openingDate);
  if (!open || !recoupedDate) return null;

  const m = /^(\d{4})-(\d{2})$/.exec(recoupedDate.trim());
  if (!m) return null; // year-only or malformed
  const year = parseInt(m[1], 10);
  const monthIdx = parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;

  const monthStart = new Date(year, monthIdx, 1);
  const close = parseIsoDay(closingDate);
  if (monthStart.getTime() > now.getTime()) return null;
  if (close && monthStart.getTime() > close.getTime()) return null;

  let recoup = new Date(year, monthIdx, 15);
  if (recoup.getTime() > now.getTime()) recoup = now;
  if (close && recoup.getTime() > close.getTime()) recoup = close;

  const diffMs = recoup.getTime() - open.getTime();
  if (diffMs < 0) return null;
  return Math.round(diffMs / WEEK_MS);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function presentValues(values: Array<number | null | undefined>): number[] {
  return values.filter((v): v is number => typeof v === 'number' && v > 0);
}

/** Weeks of data a 4-week window needs before we trust its average. */
export const MIN_WEEKS_PER_WINDOW = 3;

/** % change in the 4-week mean gross that the display badge calls a trend. */
export const DISPLAY_TREND_THRESHOLD_PCT = 3;

/**
 * Average weekly gross over the most recent `window` weeks.
 * `grossesNewestFirst[0]` is the latest reported week across Broadway; a
 * missing entry means the show did not report that week. Returns null when
 * fewer than MIN_WEEKS_PER_WINDOW weeks reported (new or closed shows).
 */
export function trailingAverageGross(
  grossesNewestFirst: Array<number | null | undefined>,
  window = 4,
): number | null {
  const recent = presentValues(grossesNewestFirst.slice(0, window));
  if (recent.length < Math.min(MIN_WEEKS_PER_WINDOW, window)) return null;
  return mean(recent);
}

/**
 * Box office trend: trailing 4-week mean gross vs the prior 4-week mean.
 * (It used to average week-over-week % changes, which one holiday week could
 * swing.) `thresholdPct` is the % change that counts as a trend rather than
 * 'steady'. 'unknown' when either window has fewer than MIN_WEEKS_PER_WINDOW
 * reported weeks, which is also what a closed show gets.
 */
export function computeGrossTrend(
  grossesNewestFirst: Array<number | null | undefined>,
  thresholdPct: number = DISPLAY_TREND_THRESHOLD_PCT,
): RecoupmentTrend {
  const recent = presentValues(grossesNewestFirst.slice(0, 4));
  const prior = presentValues(grossesNewestFirst.slice(4, 8));
  if (recent.length < MIN_WEEKS_PER_WINDOW || prior.length < MIN_WEEKS_PER_WINDOW) return 'unknown';
  const priorMean = mean(prior);
  if (priorMean <= 0) return 'unknown';
  const changePct = ((mean(recent) - priorMean) / priorMean) * 100;
  if (changePct > thresholdPct) return 'improving';
  if (changePct < -thresholdPct) return 'declining';
  return 'steady';
}

export interface CapitalSummary {
  /** Sum of the capitalizations we know. */
  knownTotal: number;
  /** Shows counted. */
  showCount: number;
  /** Shows counted whose capitalization is not public. */
  undisclosedCount: number;
}

/** Sum capitalizations without treating an unknown figure as $0. */
export function summarizeCapital(caps: Array<number | null | undefined>): CapitalSummary {
  let knownTotal = 0;
  let undisclosedCount = 0;
  for (const cap of caps) {
    if (typeof cap === 'number' && cap > 0) knownTotal += cap;
    else undisclosedCount++;
  }
  return { knownTotal, showCount: caps.length, undisclosedCount };
}

/**
 * Left out of season recoupment math and capital at risk (BRO-4623 P0-6):
 * pure nonprofits and tour stops carry no commercial investor capital.
 * Enhancement deals (e.g. Ragtime LCT 2025) keep designation 'Nonprofit' for
 * taxonomy but carry commercial co-producer capital, so they stay in.
 */
export function isExcludedFromSeasonStats(commercial: {
  designation?: string | null;
  productionType?: string | null;
}): boolean {
  const isPureNonprofit = commercial.designation === 'Nonprofit' && commercial.productionType !== 'enhancement';
  return isPureNonprofit || commercial.designation === 'Tour Stop';
}

/** Running = capital still exposed (open or in previews). */
export function isRunningStatus(status: string | null | undefined): boolean {
  return status === 'open' || status === 'previews';
}

export interface AtRiskInput {
  status: string | null | undefined;
  recouped: boolean | null | undefined;
  /** Model range [pessimistic, central, optimistic] that clears the display quality floor, else null. */
  recoupmentRange: [number, number, number] | null;
  /** Trailing 4-week average gross, null when not enough weeks reported. */
  avgGross: number | null;
  /** Weekly break-even (getBreakEven), null when unknown. */
  breakEven: number | null;
}

/** Optimistic-case recoupment below this (%) counts as "less than 30% recouped". */
export const AT_RISK_MAX_RECOUPED_PCT = 30;

/**
 * A running, unrecouped show is "at risk" only when we can show both halves of
 * the claim: its 4-week average gross is under break-even AND even the
 * optimistic model case has it under 30% recouped. A show with no estimate is
 * skipped (a missing estimate used to default to 0 and list Maybe Happy
 * Ending as "<30% recouped" with no data).
 */
export function isAtRisk(input: AtRiskInput): boolean {
  if (!isRunningStatus(input.status) || input.recouped === true) return false;
  if (!input.recoupmentRange) return false;
  if (input.avgGross == null || input.breakEven == null || input.breakEven <= 0) return false;
  if (input.avgGross >= input.breakEven) return false;
  return input.recoupmentRange[2] < AT_RISK_MAX_RECOUPED_PCT;
}

/** Low end of the model range must reach this (%) to list a show as approaching recoupment. */
export const APPROACHING_MIN_LOW_PCT = 50;

/** "Approaching recoupment" needs the pessimistic case at 50%+, not just the central estimate. */
export function isApproachingRecoupment(range: [number, number, number] | null): boolean {
  return !!range && range[0] >= APPROACHING_MIN_LOW_PCT;
}
