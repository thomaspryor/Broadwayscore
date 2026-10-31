/**
 * Box Office Scorecard v2 (BRO-5007): the words and tones the card prints,
 * kept out of the components so they can be tested. Pure; no data imports.
 *
 * Unreleased: only reachable when featureFlags.commercial && boxOfficeV2.
 */
import type { CostBand, Availability, MultiplePoint, CoverCosts, Streak, MultipleRange } from './box-office-status';
import { costSourceDate } from './box-office-status';
import type { ShowBoxOfficeV2 } from './data-commercial';
import type { PersonalBests } from './box-office-market';
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
  'well-above': 'Well Above Break-even',
  above: 'Above Break-even',
  near: 'Near Break-even',
  below: 'Below Break-even',
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

/** Whether the Profitability Scorecard's break-even section has anything to say for this show. */
export function showsBreakEven(card: Pick<BoxOfficeV2Card, 'availability' | 'multiple'>): boolean {
  return (card.availability === 'ok' && !!card.multiple) || card.availability === 'early';
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

/** A multiple as a share of break-even (0.86 → "86%"): the Profitability Scorecard's unit. */
export function formatShare(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function shareRangeText(m: MultipleRange): string {
  return `${formatShare(m.lo)} to ${formatShare(m.hi)}`;
}

export function streakText(s: Streak | null): string | null {
  if (!s || s.weeks < 2) return null;
  const n = `${s.atLeast ? 'at least ' : ''}${s.weeks}`;
  return `${n} straight weeks ${s.side} break-even`;
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
  if (m.mid < 0.95) return 'Our estimate is rough enough that it could be close, so we call it Near Break-even rather than Below.';
  if (m.mid > 1.05) return 'Our estimate is rough enough that it could be just breaking even, so we call it Near Break-even rather than Above.';
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

/** What it would take to break even: only when the show is short of it. */
export function coverTiles(c: CoverCosts | null): CoverTile[] {
  if (!c || !(c.shortBy > 0)) return [];
  const intake = `averages ${formatWeekly(c.avgGross)} vs. ${formatWeekly(c.breakEven)}`;
  const tiles: CoverTile[] = [
    {
      label: 'Short of break-even by', value: formatWeekly(c.shortBy), detail: `Averages ${formatWeekly(c.avgGross)} a week (last 4 wks) vs. ${formatWeekly(c.breakEven)}`,
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

// ---------------------------------------------------------------------------
// Box Office Scorecard (v3): Broadway League facts only, no cost.

/** Gaps under this many points read "in line with Broadway"; at or over, the show is out of step with the season. */
export const YOY_GAP_POINTS = 10;

/** "$633K" → "$630K", "$1,887K" → "$1.89M": the steady-range sentence says "about". */
function aboutWeekly(n: number): string {
  const tens = Math.round(n / 10_000);
  if (tens >= 100) return `$${String(tens / 100)}M`;
  return `$${tens * 10}K`;
}

function upDown(pct: number): string {
  const n = Math.round(Math.abs(pct));
  return n === 0 ? 'flat' : `${pct > 0 ? 'up' : 'down'} ${n}%`;
}

/** "since June", or "since December 2025" when the stretch began in an earlier year than `week`. */
function sinceText(since: string, week: string): string {
  const d = new Date(`${since}T12:00:00Z`);
  const month = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  return since.slice(0, 4) === week.slice(0, 4) ? `since ${month}` : `since ${month} ${since.slice(0, 4)}`;
}

/** A part of the year-ago change under this many percent counts as unchanged when splitting it into audience and price. */
export const YOY_PART_STEADY_PCT = 5;

export interface YearAgoParts {
  show: number | null;
  market: number | null;
  /** Tickets sold and average ticket, each against the same week a year ago. */
  attendance?: number | null;
  atp?: number | null;
  /** All of Broadway's tickets sold, same two weeks. */
  marketAttendance?: number | null;
}

/** ", almost all from lower average ticket prices (attendance is down 1%)", or both parts when both moved. */
function yoyParts(attendance: number, atp: number): string {
  const attSteady = Math.abs(attendance) < YOY_PART_STEADY_PCT;
  const atpSteady = Math.abs(atp) < YOY_PART_STEADY_PCT;
  if (attSteady && !atpSteady) return `, almost all from ${atp < 0 ? 'lower' : 'higher'} average ticket prices (attendance is ${upDown(attendance)})`;
  if (atpSteady && !attSteady) return `, almost all from ${attendance < 0 ? 'smaller' : 'bigger'} audiences (the average ticket is ${upDown(atp)})`;
  return `: attendance is ${upDown(attendance)} and the average ticket is ${upDown(atp)}`;
}

/**
 * How this show's year compares with Broadway's, or null without both gross
 * changes. Out of line with Broadway, the change is split into audience and
 * price; "slipping" (or "outpacing") is said only when the show's own
 * attendance moved further than Broadway's, since a price cut alone is a
 * pricing choice, not lost demand.
 */
export function yearAgoSentence(y: YearAgoParts): string | null {
  const { show, market } = y;
  if (show == null || market == null) return null;
  if (Math.abs(show - market) < YOY_GAP_POINTS) return `It is ${upDown(show)} from a year ago, in line with Broadway as a whole (${upDown(market)}).`;
  const att = y.attendance ?? null;
  const atp = y.atp ?? null;
  const first = `It is ${upDown(show)} from a year ago${att != null && atp != null ? yoyParts(att, atp) : ''}.`;
  const mkt = y.marketAttendance ?? null;
  if (att != null && mkt != null) {
    if (att < 0 && att <= mkt - YOY_PART_STEADY_PCT) {
      return `${first} Its audience fell more than Broadway’s (${upDown(mkt)}), so the show is slipping against the season.`;
    }
    if (att > 0 && att >= mkt + YOY_PART_STEADY_PCT) {
      return `${first} Its audience grew more than Broadway’s (${upDown(mkt)}), so the show is outpacing the season.`;
    }
  }
  return `${first} Broadway as a whole is ${upDown(market)}.`;
}

export interface FactsStoryInput {
  week: string;
  yearAgoPct: number | null;
  marketYearAgoPct: number | null;
  attendanceYoyPct?: number | null;
  atpYoyPct?: number | null;
  marketAttendanceYoyPct?: number | null;
  steady: { low: number; high: number; since: string } | null;
}

/** The Box Office Scorecard's sentences: facts only. The pointer to costs prints only when the Profitability Scorecard is on the page. */
export function factsStory(f: FactsStoryInput, hasCommercial: boolean): string | null {
  const parts: string[] = [];
  const yoy = yearAgoSentence({
    show: f.yearAgoPct, market: f.marketYearAgoPct,
    attendance: f.attendanceYoyPct, atp: f.atpYoyPct, marketAttendance: f.marketAttendanceYoyPct,
  });
  if (yoy) parts.push(yoy);
  if (f.steady) parts.push(`Weekly grosses have held between about ${aboutWeekly(f.steady.low)} and ${aboutWeekly(f.steady.high)} ${sinceText(f.steady.since, f.week)}.`);
  if (!parts.length) return null;
  if (hasCommercial) parts.push('Strong sales don’t always mean profit; costs are on the Profitability Scorecard below.');
  return parts.join(' ');
}

/** What the Box Office Scorecard receives: numbers already turned into its sentence. */
export interface BoxOfficeFactsCard {
  week: string;
  /** False for a closed (or dark) show: the numbers are its last reported week. */
  current: boolean;
  gross: number;
  rank: number;
  of: number;
  story: string | null;
  series: Array<{ week: string; gross: number | null }>;
  /** The Profitability Scorecard renders below, so the card may point to it. */
  hasCommercial: boolean;
  /** This run's records, ready to print; null under the minimum weeks. */
  bests: BestLine[] | null;
}

export function toFactsCard(
  f: FactsStoryInput & { current: boolean; gross: number; rank: number; of: number; series: BoxOfficeFactsCard['series']; bests?: PersonalBests | null },
  hasCommercial: boolean,
  closed = false,
): BoxOfficeFactsCard {
  return { week: f.week, current: f.current, gross: f.gross, rank: f.rank, of: f.of, story: factsStory(f, hasCommercial), series: f.series, hasCommercial, bests: bestLines(f.bests ?? null, f.current, closed) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Dec 29, 2024" for a YYYY-MM-DD week ending. */
export function weekEndingText(week: string): string {
  const [y, m, d] = week.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export interface BestLine {
  label: string;
  value: string;
  /** "week ending Dec 29, 2024" */
  when: string;
  /** "this week $1.6M", "New best this week", "this week matches it", or null when the latest week lacks the measure. */
  latest: string | null;
  isNew: boolean;
}

const BEST_LABELS: Record<PersonalBests['rows'][number]['key'], string> = {
  gross: 'Best week',
  capacity: 'Fullest week',
  atp: 'Highest average ticket',
};

function bestValue(key: PersonalBests['rows'][number]['key'], v: number): string {
  if (key === 'gross') return formatGross(v);
  if (key === 'capacity') return `${Math.round(v)}% full`;
  return `$${Math.round(v)}`;
}

/**
 * The personal-bests rows as printed. The latest week reads "this week" for a
 * show in the current week, "final week" for a closed show and "latest week"
 * otherwise (a running show that missed a League week). When it set the
 * record the row says so instead of repeating the value; when it only rounds
 * to the record it says it matches.
 */
export function bestLines(b: PersonalBests | null, current: boolean, closed = false): BestLine[] | null {
  if (!b || !b.rows.length) return null;
  const latestWord = current ? 'this week' : closed ? 'final week' : 'latest week';
  return b.rows.map((r) => {
    const value = bestValue(r.key, r.value);
    const latestValue = r.latest == null ? null : bestValue(r.key, r.latest);
    let latest: string | null;
    if (r.latestIsRecord) latest = current ? 'New best this week' : closed ? 'Set in its final week' : 'Set in its latest week';
    else if (latestValue == null) latest = null;
    else if (latestValue === value) latest = `${latestWord} matches it`;
    else latest = `${latestWord} ${latestValue}`;
    return { label: BEST_LABELS[r.key], value, when: `week ending ${weekEndingText(r.week)}`, latest, isNew: r.latestIsRecord };
  });
}

/** A headline weekly gross: $676K under a million, $2.7M above (matches the This Week tile). */
export function formatGross(n: number): string {
  return n >= 999_500 ? formatMillions(n) : formatWeekly(n);
}

/** Market totals in millions, one decimal ($27.7M). */
export function formatMillions(n: number): string {
  return `$${(n / 1_000_000).toFixed(1)}M`;
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
