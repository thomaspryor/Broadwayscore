/**
 * BRO-5505: how a show's recoupment moved, and a season's recoupment in one
 * line. Pure: the show card and the season page render what these return.
 *
 * - getAnalystRecoupTrend: the analyst's dated "Estimated percentage
 *   recouped" anchors (ShowCommercial.analystRecoupHistory, written by
 *   scripts/lib/waltz-recoup-estimates.js) as steps for a small chart.
 * - getSeasonRecoupHeadline: counts and ranges from the % Recouped cells
 *   (getRecoupedCellSummary). Never a dollar figure: an aggregate dollar sum
 *   of estimates needs owner sign-off (card BRO-5505).
 */
import type { RecoupedCellSummary } from './commercial-display';

export interface RecoupHistoryAnchor {
  asOf: string;
  pct: [number, number];
  postId?: string | null;
}

export interface RecoupTrendStep {
  /** First and last date the figure stood (the next anchor's date, or the series end). */
  from: string;
  to: string;
  low: number;
  high: number;
}

export interface RecoupTrend {
  steps: RecoupTrendStep[];
  start: string;
  end: string;
  /** e.g. "0-20% in Oct 2025, 30-50% since Apr 2026", or "0-20% since Oct 2025". */
  summary: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** One anchor reads as a trend only when it has stood this long. */
export const MIN_FLAT_TREND_DAYS = 60;
const DAY_MS = 86_400_000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function monthLabel(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

export function pctLabel(low: number, high: number): string {
  return low === high ? `${low}%` : `${low}-${high}%`;
}

function isAnchor(a: unknown): a is RecoupHistoryAnchor {
  const x = a as RecoupHistoryAnchor | null;
  return !!x && typeof x.asOf === 'string' && ISO.test(x.asOf)
    && Array.isArray(x.pct) && x.pct.length === 2 && x.pct.every((n) => Number.isFinite(n));
}

/**
 * The steps to draw, or null when there is nothing to show a trend of: no
 * anchors, or one figure that has stood under MIN_FLAT_TREND_DAYS.
 * @param history analystRecoupHistory, any order
 * @param endAsOf the newest post carrying the figure (analystRecoupAsOf); the last step runs to it
 */
export function getAnalystRecoupTrend(history: unknown, endAsOf?: string | null): RecoupTrend | null {
  if (!Array.isArray(history)) return null;
  const anchors = history.filter(isAnchor).slice().sort((a, b) => a.asOf.localeCompare(b.asOf));
  if (!anchors.length) return null;
  const lastAsOf = anchors[anchors.length - 1].asOf;
  const end = endAsOf && ISO.test(endAsOf) && endAsOf > lastAsOf ? endAsOf : lastAsOf;
  const start = anchors[0].asOf;
  if (anchors.length === 1 && (Date.parse(end) - Date.parse(start)) / DAY_MS < MIN_FLAT_TREND_DAYS) return null;
  const steps = anchors.map((a, i) => {
    const low = Math.max(0, Math.min(a.pct[0], a.pct[1]));
    const high = Math.max(low, Math.max(a.pct[0], a.pct[1]));
    return { from: a.asOf, to: i + 1 < anchors.length ? anchors[i + 1].asOf : end, low, high };
  });
  const first = steps[0];
  const last = steps[steps.length - 1];
  const summary = steps.length === 1
    ? `${pctLabel(first.low, first.high)} since ${monthLabel(first.from)}`
    : `${pctLabel(first.low, first.high)} in ${monthLabel(first.from)}, ${pctLabel(last.low, last.high)} since ${monthLabel(last.from)}`;
  return { steps, start, end, summary };
}

export interface SeasonRecoupHeadline {
  /** Commercial shows counted (tour stops and nonprofits without investors are left out). */
  total: number;
  recouped: number;
  /** Running or closed shows with an estimate (analyst, ours or the model), and the span of those ranges. */
  estimated: number;
  estimateSpan: [number, number] | null;
  /** Closed without recouping: a loss label or a trade-reported return. */
  closedShort: number;
  noFigure: number;
  /** The line the season page prints. */
  text: string;
}

/** Counts and ranges for the season page, from each show's % Recouped cell. Null when no show counts. */
export function getSeasonRecoupHeadline(cells: RecoupedCellSummary[]): SeasonRecoupHeadline | null {
  let total = 0, recouped = 0, estimated = 0, closedShort = 0, noFigure = 0;
  let lo = Infinity, hi = -Infinity;
  for (const cell of cells) {
    if (cell.kind === 'reason' && cell.text.startsWith('Not applicable')) continue;
    total++;
    if (cell.kind === 'recouped') recouped++;
    else if (cell.kind === 'analyst' || cell.kind === 'model') {
      estimated++;
      const [l, h] = cell.kind === 'analyst' ? cell.range : [cell.pct[0], cell.pct[2]];
      lo = Math.min(lo, Math.max(0, Math.min(l, h)));
      hi = Math.max(hi, Math.min(100, Math.max(0, Math.max(l, h))));
    } else if (cell.kind === 'loss' || cell.kind === 'reported') closedShort++;
    else noFigure++;
  }
  if (!total) return null;
  const estimateSpan: [number, number] | null = estimated ? [Math.round(lo), Math.round(hi)] : null;
  // No "X of N": the Recouped tile owns the season's recoup ratio (known outcomes only).
  const parts = [`${recouped} recouped`];
  if (estimated) {
    const span = estimateSpan![0] === estimateSpan![1] ? `about ${estimateSpan![0]}%` : `between ${estimateSpan![0]}% and ${estimateSpan![1]}%`;
    parts.push(`${estimated} estimated ${span} recouped`);
  }
  if (closedShort) parts.push(`${closedShort} closed without recouping`);
  if (noFigure) parts.push(`${noFigure} with no estimate yet`);
  return { total, recouped, estimated, estimateSpan, closedShort, noFigure, text: `Recoupment: ${parts.join(', ')}.` };
}
