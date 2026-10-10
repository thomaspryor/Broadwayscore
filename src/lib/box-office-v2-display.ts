/**
 * Box Office Scorecard v2 (BRO-5007): the words and tones the card prints,
 * kept out of the components so they can be tested. Pure; no data imports.
 *
 * Unreleased: only reachable when featureFlags.commercial && boxOfficeV2.
 */
import type { CostBand, Availability, MultiplePoint, CoverCosts, Streak, MultipleRange } from './box-office-status';
import { costSourceDate } from './box-office-status';
import type { ShowBoxOfficeV2, BoxOfficeV2Market } from './data-commercial';
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

/** "Broadway Journal (Nov 17, 2023): ..." → "Broadway Journal (Nov 2023)": outlet and month, no quote. */
export function outletAndMonth(text: string): string {
  const head = text.split(':')[0].trim();
  const outlet = head.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const iso = costSourceDate(text);
  if (!iso) return outlet;
  const month = new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${outlet} (${month})`;
}

/**
 * The basis line under the story. Prints only publishable source text. An
 * estimate is cited only when the data layer passed a source, which it does
 * for a named outlet's floor quote; model-only estimates arrive with none.
 */
export function basisLine(card: Pick<BoxOfficeV2Card, 'costBasis' | 'breakEven' | 'costSourceText'>): string | null {
  if (!card.costBasis || card.breakEven == null) return null;
  const be = `${formatWeekly(card.breakEven)}/week`;
  if (card.costBasis === 'reported') {
    const src = card.costSourceText ? shortSource(card.costSourceText) : '';
    return src ? `Break-even ${be} (${src})` : `Break-even ${be}`;
  }
  return card.costSourceText ? `Est. break-even ${be} · based on ${outletAndMonth(card.costSourceText)}` : `Est. break-even ${be}`;
}

/**
 * Near Cost only because the cost figure's range crosses 1×: say so, so a
 * 0.86× show labelled Near doesn't read as a mistake. Null when the multiple
 * itself is near 1×, or when Near came from something other than the range.
 */
export function nearNote(card: Pick<BoxOfficeV2Card, 'availability' | 'band' | 'multiple'>): string | null {
  const m = card.multiple;
  if (card.availability !== 'ok' || card.band !== 'near' || !m || !(m.lo < 1 && m.hi > 1)) return null;
  if (m.mid < 0.95) return 'Our cost figure is rough enough that it could be close to breaking even, so we call it Near Cost rather than Below.';
  if (m.mid > 1.05) return 'Our cost figure is rough enough that it could be just covering costs, so we call it Near Cost rather than Above.';
  return null;
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
      label: 'At recent attendance', value: `$${Math.round(c.ticketNeeded)} avg ticket`, detail: now,
      phoneLabel: 'Avg ticket needed', phoneDetail: `at recent attendance${now ? ` (${now})` : ''}`, phoneValue: `$${Math.round(c.ticketNeeded)}`,
    });
  }
  if (c.capacityNeeded != null) {
    const over = c.capacityNeeded > 100;
    const now = c.capacityNow != null ? `4-wk avg ${Math.round(c.capacityNow)}%` : '';
    tiles.push({
      label: 'At recent prices', value: over ? 'more than a full house' : `${Math.round(c.capacityNeeded)}% full`, detail: now,
      phoneLabel: 'How full it would need to be', phoneDetail: `at recent prices${now ? ` (${now})` : ''}`, phoneValue: over ? 'more than full' : `${Math.round(c.capacityNeeded)}%`,
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

// ---------------------------------------------------------------------------
// /box-office (Phase 3): the market line, the status counts and the table's
// two cost columns.

/** Market totals in millions, one decimal ($27.7M). */
export function formatMillions(n: number): string {
  return `$${(n / 1_000_000).toFixed(1)}M`;
}

export interface MarketLine {
  gross: string;
  /** Whole-percent change vs the same week last year, null without that week. */
  changePct: number | null;
  direction: 'up' | 'down' | 'flat' | null;
  lastYearGross: string | null;
  shows: number;
  lastYearShows: number | null;
}

export function marketLine(m: BoxOfficeV2Market): MarketLine {
  const pct = m.lastYearGross ? Math.round(((m.gross - m.lastYearGross) / m.lastYearGross) * 100) : null;
  return {
    gross: formatMillions(m.gross),
    changePct: pct == null ? null : Math.abs(pct),
    direction: pct == null ? null : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat',
    lastYearGross: m.lastYearGross != null ? formatMillions(m.lastYearGross) : null,
    shows: m.shows,
    lastYearShows: m.lastYearShows,
  };
}

export type StatusCard = Pick<BoxOfficeV2Card, 'availability' | 'band' | 'closingDate' | 'multiple' | 'trend' | 'nonprofit' | 'title' | 'slug'>;

export interface CostStatusCell {
  label: string;
  tone: PillTone;
  /** 4-week gross trend (not the multiple's), null when unknown or the show has no status. */
  arrow: '↑' | '→' | '↓' | null;
  multiple: string | null;
  range: string | null;
  /** Sort key for "Vs. its cost": the multiple; null sorts last. */
  sortValue: number | null;
  /** Sort key for Status: band rank, then the multiple within the band. */
  statusSort: number;
}

const TREND_ARROW: Record<string, CostStatusCell['arrow']> = { improving: '↑', steady: '→', declining: '↓' };

/** The Status and Vs. its cost cells for one table row. `card` undefined = no commercial record. */
export function costStatusCell(card: StatusCard | undefined): CostStatusCell {
  if (!card || card.availability === 'nocost') {
    return {
      label: card?.nonprofit ? 'Nonprofit · no estimate' : 'No estimate yet',
      tone: 'pending', arrow: null, multiple: null, range: null, sortValue: null, statusSort: STATUS_SORT.nocost,
    };
  }
  const pill = costPill(card);
  const m = card.availability === 'ok' && card.band != null ? card.multiple : null;
  return {
    label: pill.label,
    tone: pill.tone,
    arrow: m ? TREND_ARROW[card.trend] ?? null : null,
    multiple: m ? formatMultiple(m.mid) : null,
    range: m ? `${m.lo.toFixed(2)}–${m.hi.toFixed(2)}` : null,
    sortValue: m ? m.mid : null,
    statusSort: (STATUS_SORT[card.availability === 'ok' && card.band ? card.band : card.availability] ?? 0) + (m ? Math.min(m.mid, 9.99) / 10 : 0),
  };
}

/** Status column order: the band first (a demoted at-risk show stays with its band), then the multiple breaks ties. */
const STATUS_SORT: Record<string, number> = { 'well-above': 40, above: 30, near: 20, below: 10, closing: 3, early: 2, nocost: 1, closed: 0 };

/**
 * The This week table's cost cells, keyed by slug, plus its rows with
 * "(nonprofit)" added to a rated nonprofit's title (the design's marker).
 */
export function costTable<R extends { show: { slug: string; title: string; status?: string } }>(
  rows: R[],
  bySlug: Record<string, StatusCard>,
): { cells: Record<string, CostStatusCell>; thisWeek: R[] } {
  const cells: Record<string, CostStatusCell> = {};
  const thisWeek = rows.map((row) => {
    const card = bySlug[row.show.slug];
    if (!card) {
      // No commercial record: a closed show will never get an estimate, so don't promise one.
      if (row.show.status === 'closed') cells[row.show.slug] = { ...costStatusCell(undefined), label: 'Closed', tone: 'muted', statusSort: STATUS_SORT.closed };
      return row;
    }
    cells[row.show.slug] = costStatusCell(card);
    return card.nonprofit && card.availability === 'ok'
      ? { ...row, show: { ...row.show, title: `${row.show.title} (nonprofit)` } }
      : row;
  });
  return { cells, thisWeek };
}

export interface StatusGroup {
  band: CostBand;
  label: string;
  tone: PillTone;
  titles: string[];
}

export interface StatusCounts {
  rated: number;
  groups: StatusGroup[];
  noEstimate: string[];
  nonprofitNoEstimate: string[];
  early: string[];
  closing: string[];
}

const BAND_ORDER: CostBand[] = ['well-above', 'above', 'near', 'below'];

/** "Who is covering their costs": running shows grouped by band, plus who is not rated and why. */
export function statusCounts(
  cards: StatusCard[],
  unrecorded: { title: string; inPreviews: boolean }[] = [],
): StatusCounts {
  // Shows with no commercial record at all: in previews they are too early, otherwise unestimated.
  const extra = unrecorded.map((u) => ({
    availability: u.inPreviews ? 'early' : 'nocost', band: null, closingDate: null, multiple: null,
    trend: 'unknown', nonprofit: false, title: u.title, slug: '',
  }) as StatusCard);
  const byTitle = [...cards, ...extra].sort((a, b) => a.title.localeCompare(b.title));
  const pick = (f: (c: StatusCard) => boolean) => byTitle.filter(f).map((c) => c.title);
  const groups = BAND_ORDER.map((band) => ({
    band,
    label: BAND_LABEL[band],
    tone: BAND_TONE[band],
    titles: pick((c) => c.availability === 'ok' && c.band === band),
  }));
  return {
    rated: groups.reduce((n, g) => n + g.titles.length, 0),
    groups,
    noEstimate: pick((c) => c.availability === 'nocost' && !c.nonprofit),
    nonprofitNoEstimate: pick((c) => c.availability === 'nocost' && c.nonprofit),
    early: pick((c) => c.availability === 'early'),
    closing: pick((c) => c.availability === 'closing' || c.availability === 'closed'),
  };
}
