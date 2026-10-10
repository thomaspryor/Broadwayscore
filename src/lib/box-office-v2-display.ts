/**
 * Box Office Scorecard v2 (BRO-5007): the words and tones the card prints,
 * kept out of the components so they can be tested. Pure; no data imports.
 *
 * Unreleased: only reachable when featureFlags.commercial && boxOfficeV2.
 */
import type { CostBand, Availability, MultiplePoint, CoverCosts, Streak, MultipleRange } from './box-office-status';
import type { ShowBoxOfficeV2 } from './data-commercial';
/** Weekly amounts in thousands ($821K, $1,084K): $1.1M hides the gap that matters week to week. */
export function formatWeekly(n: number): string {
  return `$${Math.round(n / 1000).toLocaleString('en-US')}K`;
}

/** What crosses the client boundary: no build-report-only fields. */
export type BoxOfficeV2Card = Omit<ShowBoxOfficeV2, 'noCostReason' | 'quality'>;

export function toBoxOfficeV2Card(v2: ShowBoxOfficeV2): BoxOfficeV2Card {
  const card: Partial<ShowBoxOfficeV2> = { ...v2 };
  delete card.noCostReason;
  delete card.quality;
  return card as BoxOfficeV2Card;
}

export type PillTone = 'above' | 'near' | 'below' | 'muted' | 'pending';

export interface CostPill {
  label: string;
  tone: PillTone;
}

const BAND_LABEL: Record<CostBand, string> = {
  'well-above': 'Well Above Cost',
  above: 'Above Cost',
  near: 'Near Cost',
  below: 'Below Cost',
};

const BAND_TONE: Record<CostBand, PillTone> = {
  'well-above': 'above',
  above: 'above',
  near: 'near',
  below: 'below',
};

function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** The status pill for a card or a table row. */
export function costPill(card: Pick<BoxOfficeV2Card, 'availability' | 'band' | 'closingDate'>): CostPill {
  const a: Availability = card.availability;
  if (a === 'ok' && card.band) return { label: BAND_LABEL[card.band], tone: BAND_TONE[card.band] };
  if (a === 'nocost') return { label: 'No cost estimate yet', tone: 'pending' };
  if (a === 'early') return { label: 'Too early', tone: 'pending' };
  if (a === 'closing') return { label: card.closingDate ? `Closing ${shortDate(card.closingDate)}` : 'Final weeks', tone: 'muted' };
  if (a === 'closed') return { label: card.closingDate ? `Closed ${shortDate(card.closingDate)}` : 'Closed', tone: 'muted' };
  return { label: 'No status', tone: 'pending' };
}

export function formatMultiple(x: number): string {
  return `${x.toFixed(2)}×`;
}

export function rangeText(m: MultipleRange): string {
  return `${m.lo.toFixed(2)}–${m.hi.toFixed(2)}×`;
}

export function streakText(s: Streak | null): string | null {
  if (!s || s.weeks < 2) return null;
  const n = `${s.atLeast ? 'at least ' : ''}${s.weeks}`;
  return `${n} straight weeks ${s.side} cost`;
}

export function trendText(trend: string): string | null {
  if (trend === 'improving') return '↗ improving';
  if (trend === 'declining') return '↘ declining';
  if (trend === 'steady') return '→ steady';
  return null;
}

/**
 * "Broadway Journal (Apr 25, 2018): fixed expenses averaged $643,000…" →
 * "Broadway Journal, Apr 25, 2018". The quote's dollar figure is an expense
 * line, not the break-even printed beside it, so the card shows only outlet and
 * date; the link carries the quote.
 */
export function shortSource(text: string): string {
  const head = text.split(':')[0].trim();
  return head.replace(/\s*\(([^)]*)\)\s*$/, ', $1');
}

/**
 * The basis line under the story. Prints only publishable source text; an
 * estimate never names where the estimate came from.
 */
export function basisLine(card: Pick<BoxOfficeV2Card, 'costBasis' | 'breakEven' | 'costSourceText'>): string | null {
  if (!card.costBasis || card.breakEven == null) return null;
  const be = `${formatWeekly(card.breakEven)}/week`;
  const src = card.costSourceText ? shortSource(card.costSourceText) : '';
  if (card.costBasis === 'reported') return src ? `Break-even ${be} (${src})` : `Break-even ${be}`;
  return `Est. break-even ${be}`;
}

export interface CoverTile {
  label: string;
  value: string;
  detail: string;
  /** Phone row: the question on the left, a short number on the right. */
  phoneLabel: string;
  phoneDetail: string;
  phoneValue: string;
}

/** "What it would take to cover costs": only when the show is short of its cost. */
export function coverTiles(c: CoverCosts | null): CoverTile[] {
  if (!c || !(c.shortBy > 0)) return [];
  const intake = `takes in ${formatWeekly(c.avgGross)} vs. ${formatWeekly(c.breakEven)} cost`;
  const tiles: CoverTile[] = [
    {
      label: 'Each week, it’s short by', value: formatWeekly(c.shortBy), detail: `Takes in ${formatWeekly(c.avgGross)} vs. ${formatWeekly(c.breakEven)} cost`,
      phoneLabel: 'Short each week', phoneDetail: intake, phoneValue: formatWeekly(c.shortBy),
    },
  ];
  if (c.ticketNeeded != null) {
    const now = c.ticketNow != null ? `4-wk avg $${Math.round(c.ticketNow)}` : '';
    tiles.push({
      label: 'At today’s attendance', value: `$${Math.round(c.ticketNeeded)} avg ticket`, detail: now,
      phoneLabel: 'Avg ticket needed', phoneDetail: `at today’s attendance${now ? ` (${now})` : ''}`, phoneValue: `$${Math.round(c.ticketNeeded)}`,
    });
  }
  if (c.capacityNeeded != null) {
    const over = c.capacityNeeded > 100;
    const now = c.capacityNow != null ? `4-wk avg ${Math.round(c.capacityNow)}%` : '';
    tiles.push({
      label: 'At today’s prices', value: over ? 'more than a full house' : `${Math.round(c.capacityNeeded)}% full`, detail: now,
      phoneLabel: 'How full it would need to be', phoneDetail: `at today’s prices${now ? ` (${now})` : ''}`, phoneValue: over ? 'more than full' : `${Math.round(c.capacityNeeded)}%`,
    });
  }
  return tiles;
}

/**
 * Evenly spaced y-axis ticks for the multiple chart, from 0 to `max`. Half
 * steps up to 3×, whole steps up to 8× (so 1×, the cost line, always gets a
 * label), then steps of 2.
 */
export function multipleTicks(max: number): number[] {
  const step = max <= 3 ? 0.5 : max <= 8 ? 1 : 2;
  const out: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) out.push(Math.round(t * 10) / 10);
  return out;
}

/** Chart points with a multiple, or gross-only when the show has no cost. */
export function chartMode(series: MultiplePoint[]): 'multiple' | 'gross' | 'none' {
  if (series.some((p) => p.multiple != null)) return 'multiple';
  if (series.some((p) => p.gross != null)) return 'gross';
  return 'none';
}
