// Season profile for the commercial scorecard (/biz, /biz/season/[season]):
// what a Broadway season opened (plays vs musicals, originals vs revivals),
// what it cost (disclosed capitalization, weekly running cost) and how many
// shows recouped, compared with last season and the 10-season average.
//
// Pure: no data imports. data-commercial.ts feeds it shows.json +
// commercial.json rows; tests/unit/season-profile.test.ts calls it with
// fixtures.

import { getSeason, isExcludedFromSeasonStats } from './commercial-metrics';
import { formatSeasonMoney } from './formatting';
import { ownReturnedRangePct } from '../../scripts/lib/commercial-designations';
import { sourceOpensAsEstimate } from '../../scripts/lib/public-source-text';
import { MIN_AVERAGE_SAMPLE, CAP_ESTIMATE_WINDOWS, estimateCapitalization, continuationIds } from '../../scripts/lib/cap-comparables';

// One definition with the recoupment model's fallback (BRO-5849).
export { MIN_AVERAGE_SAMPLE, CAP_ESTIMATE_WINDOWS, estimateCapitalization };

export interface SeasonShowInput {
  /** commercial.json key (the show slug); lets a later run of the same title be recognised as a continuation (continuesEarlierRun). */
  id?: string;
  type: string | null | undefined;
  isRevival: boolean | null | undefined;
  openingDate: string;
  /** shows.json status; a closed show with only a research placeholder counts as untracked (trackedRecord). */
  status?: string | null;
  /** commercial.json record, null when the show is not tracked there. */
  commercial: {
    capitalization?: number | null;
    /** Read by isOwnEstimate: our own estimate is not a disclosed figure. */
    isEstimate?: Record<string, boolean | undefined> | null;
    capitalizationSource?: string | null;
    /**
     * Weekly running cost as recorded. Supplied by data-commercial.ts, the
     * approved reader of the running-cost field in commercial data (cost-for-week
     * baseline test); this lib only averages it.
     */
    weeklyCost?: number | null;
    recouped?: boolean | null;
    designation?: string | null;
    sources?: unknown[] | null;
    productionType?: string | null;
    /** Producing nonprofit (Roundabout, MTC, LCT...), also set on enhancement and converted runs. */
    nonprofitOrg?: string | null;
    /** A reported multiple of capitalization returned (only counts with a cited source). */
    investorMultiple?: number | null;
    /** Our own estimate of the share of capitalization returned (ownReturnedRangePct reads these). */
    analystRecoupPct?: number[] | number | null;
    estimatedRecoupmentPct?: number[] | number | null;
    ourEstimateRangePct?: number[] | number | null;
    /** Our recoupment model, % of capitalization returned as [low, mid, high]. */
    modelReturnedExCreditPct?: number[] | null;
    modelRecoupmentPctV2?: number[] | null;
    modelRecoupmentPct?: number[] | null;
  } | null;
}

export interface MoneyAggregate {
  /** Shows with a disclosed figure. */
  known: number;
  /** Shows the figure could apply to (commercial shows in the bucket). */
  of: number;
  total: number;
}

export interface SeasonProfile {
  season: string;
  productions: number;
  musicals: number;
  plays: number;
  /** Specials, operas, untyped: in the production count, in neither bucket. */
  other: number;
  revivals: number;
  /** Productions whose original/revival status is known (denominator for revival shares). */
  revivalKnown: number;
  musicalRevivals: number;
  musicalRevivalKnown: number;
  playRevivals: number;
  playRevivalKnown: number;
  /** Days from the July 1 season start to each opening, for "opened by this point" comparisons. */
  openingDayOffsets: number[];
  /** Productions with a commercial.json record. */
  tracked: number;
  /** Tracked productions produced by a nonprofit theater (nonprofitOrg set). */
  nonprofit: number;
  /** Tracked productions with investors to repay: not a pure nonprofit run or tour stop (the recoupment and capital denominator). */
  commercial: number;
  recouped: number;
  /**
   * Commercial productions with an outcome we know (BRO-6354): recouped true or
   * false, or still running. A closed show whose recouped flag is null carries
   * only a model-estimate label (Flop, Fizzle...), so it is in `commercial` but
   * out of the recoup rate's denominator.
   */
  outcomeKnown: number;
  capitalization: { all: MoneyAggregate; musical: MoneyAggregate; play: MoneyAggregate };
  /** Disclosed capitalizations plus an estimate for each commercial show with none (estimateCapitalization). */
  estimatedCapital: CapitalEstimate;
  /**
   * The same per-show figures as estimatedCapital, split by outcome (owner,
   * 2026-10-26: the season page's only loss-side number was capital still at
   * risk in running shows). Shows with no figure count in neither.
   */
  capitalByOutcome: { closedUnrecouped: number; closedUnrecoupedShows: number; running: number; runningShows: number };
  /** Our estimate of the money that has come back to investors (returnedCapitalShare), with a low-high band. */
  returnedCapital: ReturnedCapital;
  runningCost: { musical: MoneyAggregate; play: MoneyAggregate };
}

export interface ReturnedCapital {
  /** Capital of the shows with a returned estimate: the "of $Y in" the dollars below come back from. */
  capital: number;
  low: number;
  mid: number;
  high: number;
  /** Opened commercial shows with a capital figure and a returned estimate. */
  shows: number;
  /** Opened commercial shows with a capital figure (the coverage denominator for `shows`). */
  of: number;
}

export interface CapitalEstimate {
  /** Disclosed figures plus the estimates. */
  total: number;
  /** Commercial shows whose figure is an estimate. */
  estimated: number;
  /** Commercial shows with no figure and too few comparable ones to estimate. */
  missing: number;
  /**
   * Nonprofit-presented runs (enhancement deals) with no figure: left out, since
   * their investor money is a fraction of a commercial budget and almost never
   * disclosed, so commercial comparables would overstate it.
   */
  nonprofitOut: number;
}

/** Share of productions with a commercial.json record before nonprofit / recoupment rows count. */
export const MIN_TRACKED_SHARE = 0.75;
/** Share of commercial productions with a disclosed capitalization before money rows count. */
export const MIN_CAP_COVERAGE = 0.6;
/** Seasons in the long-run baseline. */
export const BASELINE_SEASONS = 10;
/** Share of commercial shows with a disclosed capitalization before two seasons' sums are compared. */
export const MIN_TOTAL_COVERAGE = 0.8;
/** A season's recoupment count joins the average once it ended this long ago (its shows mostly closed or recouped). */
export const RECOUP_SETTLE_DAYS = 365;
/**
 * Seasons the pandemic cut short (2019-20 stopped in March 2020) or emptied
 * (2020-21): left out of the baseline so they do not drag the averages.
 */
export const DISRUPTED_SEASONS = new Set(['2019-2020', '2020-2021']);

const DAY_MS = 24 * 60 * 60 * 1000;

function seasonStartMs(season: string): number {
  return Date.UTC(parseInt(season.slice(0, 4), 10), 6, 1);
}

function emptyMoney(): MoneyAggregate {
  return { known: 0, of: 0, total: 0 };
}

function addMoney(agg: MoneyAggregate, value: number | null | undefined): void {
  agg.of++;
  if (typeof value === 'number' && value > 0) {
    agg.known++;
    agg.total += value;
  }
}

function emptyProfile(season: string): SeasonProfile {
  return {
    season,
    productions: 0, musicals: 0, plays: 0, other: 0,
    revivals: 0, revivalKnown: 0,
    musicalRevivals: 0, musicalRevivalKnown: 0,
    playRevivals: 0, playRevivalKnown: 0,
    openingDayOffsets: [],
    tracked: 0, nonprofit: 0, commercial: 0, recouped: 0, outcomeKnown: 0,
    capitalization: { all: emptyMoney(), musical: emptyMoney(), play: emptyMoney() },
    estimatedCapital: { total: 0, estimated: 0, missing: 0, nonprofitOut: 0 },
    capitalByOutcome: { closedUnrecouped: 0, closedUnrecoupedShows: 0, running: 0, runningShows: 0 },
    returnedCapital: { capital: 0, low: 0, mid: 0, high: 0, shows: 0, of: 0 },
    runningCost: { musical: emptyMoney(), play: emptyMoney() },
  };
}

interface DisclosedCap {
  year: number;
  type: string;
  isRevival: boolean | null;
  capitalization: number;
}


/**
 * True when a show's capitalization is our own estimate (isEstimate flag or an
 * "Estimate:" source), not a public figure (BRO-5647: six such budgets were
 * counted as disclosed). Decided from the record, so buildSeasonProfiles and
 * getSeasonStats (data-commercial.ts) agree.
 */
export function isOwnEstimate(c: Pick<NonNullable<SeasonShowInput['commercial']>, 'capitalization' | 'isEstimate' | 'capitalizationSource'>): boolean {
  // Not isEstimatedCapitalization: it also marks an uncited figure, a display
  // rule ("~" on an unsourced number); here only our own estimates leave the
  // disclosed counts.
  return typeof c.capitalization === 'number' && c.capitalization > 0
    && (c.isEstimate?.capitalization === true || sourceOpensAsEstimate(c.capitalizationSource));
}

/** True when a show runs on capital already counted for an earlier production of the same title (continuationIds). */
export function continuesEarlierRun(show: SeasonShowInput, all: SeasonShowInput[]): boolean {
  return !!show.id && continuationIds(all.map((o) => ({
    id: o.id, openingDate: o.openingDate, capitalization: o.commercial?.capitalization, capitalizationSource: o.commercial?.capitalizationSource,
  }))).has(show.id);
}

const clampPct = (v: number) => Math.min(100, Math.max(0, v));

function triple(v: unknown): [number, number, number] | null {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n)) ? [v[0], v[1], v[2]] : null;
}

/**
 * Share of a show's capitalization that has come back to investors, as
 * fractions (1 = all of it) low <= mid <= high; null with no basis (BRO-6335).
 *  - recouped: the reported multiple when the record cites a source, else 1.
 *  - closed, not recouped: our own estimate of the share returned (a range
 *    counts as low-high), else the model's [low, mid, high]; clamped to 0-100%.
 *  - running, not recouped: the model's [low, mid, high], clamped.
 * Not-yet-open shows have no share (nothing has played to return).
 */
export function returnedCapitalShare(
  c: NonNullable<SeasonShowInput['commercial']>, status: string | null | undefined,
): { low: number; mid: number; high: number } | null {
  if (c.recouped === true) {
    const m = c.investorMultiple;
    const cited = Array.isArray(c.sources) && c.sources.some((x) => typeof (x as { url?: unknown })?.url === 'string' && /^https?:\/\//.test((x as { url: string }).url));
    const reported = typeof m === 'number' && Number.isFinite(m) && m > 0 && cited;
    const v = reported ? m : 1;
    return { low: v, mid: v, high: v };
  }
  let pct: [number, number, number] | null = null;
  if (status === 'closed') {
    const own = ownReturnedRangePct(c);
    if (own) pct = [own[0], (own[0] + own[1]) / 2, own[1]];
  }
  if (!pct && (status === 'closed' || status === 'open' || status === 'previews')) {
    pct = triple(c.modelReturnedExCreditPct) ?? triple(c.modelRecoupmentPctV2) ?? triple(c.modelRecoupmentPct);
  }
  // A closed show on the record as not recouped, with no estimate of our own,
  // whose model reads at or above the 99% cap contradicts that record: the model
  // cannot size the shortfall, so the show gets no share instead of a clamped
  // ~99% (BRO-6360: Music Man, Frozen, Death of a Salesman).
  if (pct && status === 'closed' && !ownReturnedRangePct(c) && pct[1] >= 99) return null;
  if (!pct) return null;
  // Not recouped means under 100%: a model reading above it (a Fizzle or Did
  // Not Recoup record whose model runs hot) must not count as fully repaid.
  const [lo, mid, hi] = pct.map((v) => Math.min(99, clampPct(v))).sort((a, b) => a - b);
  return { low: lo / 100, mid: mid / 100, high: hi / 100 };
}

interface RecordFacts {
  designation?: string | null;
  recouped?: boolean | null;
  capitalization?: number | null;
  sources?: unknown[] | null;
}

/**
 * The record a show counts with, null when it counts as untracked. Research
 * leaves a TBD placeholder (attempt bookkeeping, no sources, no figures) on
 * every show it looks at; on a closed show that is an unknown outcome, not a
 * show that failed to recoup, and counting it would make an unresearched
 * season look tracked with almost nothing recouped. A running show's
 * placeholder still counts (not recouped yet).
 */
export function trackedRecord<C extends RecordFacts>(show: { status?: string | null; commercial: C | null }): C | null {
  const c = show.commercial;
  if (c && show.status === 'closed' && isResearchPlaceholder(c)) return null;
  return c;
}

function isResearchPlaceholder(c: RecordFacts): boolean {
  return c.designation === 'TBD' && typeof c.recouped !== 'boolean'
    && !(typeof c.capitalization === 'number' && c.capitalization > 0)
    && !(Array.isArray(c.sources) && c.sources.length > 0);
}

/**
 * True when a commercial show's recoupment outcome is known: a recouped flag
 * of true or false, or a show running now (open or previews: not recouped
 * yet). A closed show with recouped null has only a model-estimate label, and
 * an unopened or status-less one has no outcome yet.
 */
export function hasKnownOutcome(status: string | null | undefined, c: { recouped?: boolean | null }): boolean {
  return typeof c.recouped === 'boolean' || status === 'open' || status === 'previews';
}

/** One profile per season (July 1 - June 30), newest first. */
export function buildSeasonProfiles(shows: SeasonShowInput[]): SeasonProfile[] {
  const continuations = continuationIds(shows.map((o) => ({
    id: o.id, openingDate: o.openingDate, capitalization: o.commercial?.capitalization, capitalizationSource: o.commercial?.capitalizationSource,
  })));
  const continues = (show: SeasonShowInput) => !!show.id && continuations.has(show.id);
  const disclosed: DisclosedCap[] = [];
  for (const show of shows) {
    const season = getSeason(show.openingDate);
    const c = trackedRecord(show);
    if (!season || !c || isExcludedFromSeasonStats(c) || c.nonprofitOrg || continues(show)) continue;
    if (typeof c.capitalization === 'number' && c.capitalization > 0 && !isOwnEstimate(c)) {
      disclosed.push({
        year: parseInt(season.slice(0, 4), 10),
        type: show.type ?? '',
        isRevival: typeof show.isRevival === 'boolean' ? show.isRevival : null,
        capitalization: c.capitalization,
      });
    }
  }

  const bySeason = new Map<string, SeasonProfile>();
  for (const show of shows) {
    const season = getSeason(show.openingDate);
    if (!season) continue;
    let p = bySeason.get(season);
    if (!p) {
      p = emptyProfile(season);
      bySeason.set(season, p);
    }
    p.productions++;
    p.openingDayOffsets.push(Math.floor((Date.parse(show.openingDate) - seasonStartMs(season)) / DAY_MS));

    const isMusical = show.type === 'musical';
    const isPlay = show.type === 'play';
    if (isMusical) p.musicals++;
    else if (isPlay) p.plays++;
    else p.other++;

    if (typeof show.isRevival === 'boolean') {
      p.revivalKnown++;
      if (show.isRevival) p.revivals++;
      if (isMusical) {
        p.musicalRevivalKnown++;
        if (show.isRevival) p.musicalRevivals++;
      } else if (isPlay) {
        p.playRevivalKnown++;
        if (show.isRevival) p.playRevivals++;
      }
    }

    const c = trackedRecord(show);
    if (!c) continue;
    p.tracked++;
    if (c.nonprofitOrg) p.nonprofit++;
    if (isExcludedFromSeasonStats(c)) continue;
    // A continuation run's raise is already counted with the earlier run: out of the capital counts and denominators (BRO-6360).
    if (continues(show)) continue;
    p.commercial++;
    if (c.recouped === true) p.recouped++;
    if (hasKnownOutcome(show.status, c)) p.outcomeKnown++;
    // Our own estimate of a show's budget is not a disclosed figure: it stays
    // out of the disclosed sums and averages, and fills the estimated total
    // ahead of the comparables median.
    const disclosedCap = isOwnEstimate(c) ? null : c.capitalization;
    addMoney(p.capitalization.all, disclosedCap);
    let showCap: number | null = null;
    if (typeof disclosedCap === 'number' && disclosedCap > 0) {
      showCap = disclosedCap;
      p.estimatedCapital.total += disclosedCap;
    } else if (typeof c.capitalization === 'number' && c.capitalization > 0) {
      showCap = c.capitalization;
      p.estimatedCapital.total += c.capitalization;
      p.estimatedCapital.estimated++;
    } else if (c.nonprofitOrg) {
      p.estimatedCapital.nonprofitOut++;
    } else {
      const est = estimateCapitalization(
        disclosed, parseInt(season.slice(0, 4), 10), show.type ?? '', typeof show.isRevival === 'boolean' ? show.isRevival : null,
      );
      if (est === null) p.estimatedCapital.missing++;
      else {
        showCap = est;
        p.estimatedCapital.total += est;
        p.estimatedCapital.estimated++;
      }
    }
    if (showCap !== null && (c.recouped === true || show.status === 'closed' || show.status === 'open' || show.status === 'previews')) {
      p.returnedCapital.of++;
      const share = returnedCapitalShare(c, show.status);
      if (share) {
        const r = p.returnedCapital;
        r.shows++;
        r.capital += showCap;
        r.low += showCap * share.low;
        r.mid += showCap * share.mid;
        r.high += showCap * share.high;
      }
    }
    if (showCap !== null && c.recouped !== true) {
      if (show.status === 'closed') {
        p.capitalByOutcome.closedUnrecouped += showCap;
        p.capitalByOutcome.closedUnrecoupedShows++;
      } else if (show.status === 'open' || show.status === 'previews') {
        p.capitalByOutcome.running += showCap;
        p.capitalByOutcome.runningShows++;
      }
    }
    if (isMusical) {
      addMoney(p.capitalization.musical, disclosedCap);
      addMoney(p.runningCost.musical, c.weeklyCost);
    } else if (isPlay) {
      addMoney(p.capitalization.play, disclosedCap);
      addMoney(p.runningCost.play, c.weeklyCost);
    }
  }
  return Array.from(bySeason.values()).sort((a, b) => b.season.localeCompare(a.season));
}

/**
 * Seasons the average row rests on: the season under way plus the ten before it,
 * whatever rows the table lists, so listing older seasons does not move it (BRO-6362).
 */
export function selectSeasonAverageBase(profiles: SeasonProfile[], currentSeason: string | null): SeasonProfile[] {
  return profiles.filter((p) => !currentSeason || p.season <= currentSeason).slice(0, BASELINE_SEASONS + 1);
}

/**
 * Rows for the Season by Season table (BRO-6362): newest first, from the
 * current season back through the oldest season that clears hasTrackedCoverage,
 * so a backfilled season appears without a code change. No fixed row cap.
 */
export function selectSeasonHistory(profiles: SeasonProfile[], currentSeason: string | null): SeasonProfile[] {
  const upTo = profiles.filter((p) => !currentSeason || p.season <= currentSeason);
  let oldest = -1;
  upTo.forEach((p, i) => {
    if (p.season === currentSeason || hasTrackedCoverage(p)) oldest = i;
  });
  return upTo.slice(0, oldest + 1);
}

/** Enough commercial.json coverage to state nonprofit share and recoupment counts. */
export function hasTrackedCoverage(p: SeasonProfile): boolean {
  return p.productions > 0 && p.tracked / p.productions >= MIN_TRACKED_SHARE;
}

/** Enough disclosed capitalizations to state money figures. */
export function hasCapitalCoverage(p: SeasonProfile): boolean {
  return hasTrackedCoverage(p) && p.commercial > 0
    && p.capitalization.all.known / p.commercial >= MIN_CAP_COVERAGE;
}

/** Nearly every budget public: a season's capitalization sum can be set beside another's. */
export function hasFullCapitalCoverage(p: SeasonProfile): boolean {
  return hasTrackedCoverage(p) && p.commercial > 0
    && p.capitalization.all.known / p.commercial >= MIN_TOTAL_COVERAGE;
}

/** Tracked well enough that the estimated capital total (disclosed + estimates) can be stated. */
export function hasEstimatedCapital(p: SeasonProfile): boolean {
  return hasTrackedCoverage(p) && p.commercial > 0;
}

/** Share of opened commercial shows (with a capital figure) that have a returned estimate before the dollars back are stated. */
export const MIN_RETURNED_COVERAGE = 0.6;
/** Fewest shows with a returned estimate before a season's dollars back are stated. */
export const MIN_RETURNED_SHOWS = 3;

/** Enough tracked shows with a returned estimate that "about $X back of $Y in" can be stated. */
export function hasReturnedCoverage(p: SeasonProfile): boolean {
  const r = p.returnedCapital;
  return hasEstimatedCapital(p) && r.of > 0 && r.capital > 0 && r.shows >= MIN_RETURNED_SHOWS && r.shows / r.of >= MIN_RETURNED_COVERAGE;
}

/**
 * "about $X back of $Y in" with the band, for /biz and the season page
 * (BRO-6335). Always an estimate; the range is the low-high band. null where
 * hasReturnedCoverage fails.
 */
export function returnedCapitalText(p: SeasonProfile): { headline: string; range: string; share: string } | null {
  if (!hasReturnedCoverage(p)) return null;
  const r = p.returnedCapital;
  const money = (v: number) => formatSeasonMoney(v);
  return {
    headline: `about ${money(r.mid)} back of ${money(r.capital)} in`,
    range: `${money(r.low)} to ${money(r.high)}`,
    share: `${Math.round((r.mid / r.capital) * 100)}%`,
  };
}

export interface HistoryAverage {
  /** Seasons averaged: finished, with openings, pandemic seasons left out. */
  seasons: number;
  productions: number | null;
  /** Pooled shares (all openings of the averaged seasons together) and the mean count per season. */
  musicals: { share: number | null; count: number | null };
  revivals: { share: number | null; count: number | null };
  musicalRevivals: number | null;
  playRevivals: number | null;
  /** Over averaged seasons we track well. */
  nonprofit: number | null;
  /** Over settled seasons we track well (RECOUP_SETTLE_DAYS): mean recouped and known-outcome commercial shows per season (the `commercial` field). */
  recouped: { recouped: number; commercial: number; seasons: number } | null;
  disclosedCapital: { avg: number | null; seasons: number };
  estimatedCapital: { avg: number | null; seasons: number };
}

/**
 * The average row under the season-by-season table: each column over the
 * finished seasons it is stated for (the season under way and DISRUPTED_SEASONS
 * left out), so a column's average matches the cells above it.
 */
export function seasonHistoryAverage(profiles: SeasonProfile[], currentSeason: string | null, asOf: string): HistoryAverage {
  const base = profiles.filter((p) => p.season !== currentSeason && p.productions > 0 && !DISRUPTED_SEASONS.has(p.season));
  const meanOf = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  const tracked = base.filter(hasTrackedCoverage);
  const asOfMs = Date.parse(asOf);
  const settled = tracked.filter((p) => asOfMs - Date.UTC(parseInt(p.season.slice(5), 10), 6, 1) >= RECOUP_SETTLE_DAYS * DAY_MS);
  const disclosedSeasons = base.filter(hasFullCapitalCoverage);
  const estimatedSeasons = base.filter(hasEstimatedCapital);
  return {
    seasons: base.length,
    productions: meanOf(base.map((p) => p.productions)),
    musicals: { share: pooled(base, (p) => p.musicals, (p) => p.productions), count: meanOf(base.map((p) => p.musicals)) },
    revivals: { share: pooled(base, (p) => p.revivals, (p) => p.revivalKnown), count: meanOf(base.map((p) => p.revivals)) },
    musicalRevivals: pooled(base, (p) => p.musicalRevivals, (p) => p.musicalRevivalKnown),
    playRevivals: pooled(base, (p) => p.playRevivals, (p) => p.playRevivalKnown),
    nonprofit: pooled(tracked, (p) => p.nonprofit, (p) => p.tracked),
    recouped: settled.length
      ? {
        recouped: meanOf(settled.map((p) => p.recouped)) as number,
        commercial: meanOf(settled.map((p) => p.outcomeKnown)) as number,
        seasons: settled.length,
      }
      : null,
    disclosedCapital: { avg: meanOf(disclosedSeasons.map((p) => p.capitalization.all.total)), seasons: disclosedSeasons.length },
    estimatedCapital: { avg: meanOf(estimatedSeasons.map((p) => p.estimatedCapital.total)), seasons: estimatedSeasons.length },
  };
}

/** Enough disclosed figures in this one bucket (each money row is gated on its own field). */
function hasMoneyCoverage(agg: MoneyAggregate, min = MIN_CAP_COVERAGE): boolean {
  return agg.of > 0 && agg.known / agg.of >= min;
}

export type RowFormat = 'count' | 'pct' | 'money';

export interface ComparisonRow {
  label: string;
  format: RowFormat;
  /** A season total (a sum), not a per-show figure: money prints in whole millions. */
  whole?: boolean;
  current: number | null;
  /** "12 of 32" style detail under each column's value. */
  currentDetail: string | null;
  last: number | null;
  lastDetail: string | null;
  /** The season before last (the third column, owner 2026-10-26). */
  prev: number | null;
  prevDetail: string | null;
  avg: number | null;
  /** Per-season average counts ("15.4 of 36.2") or disclosure, under the average. */
  avgDetail: string | null;
  /** Seasons the average is taken over (fewer than BASELINE_SEASONS for money and recoupment rows). */
  avgSeasons: number;
}

export interface SeasonComparison {
  season: string;
  lastSeason: string | null;
  /** The season before last with openings, or null. */
  prevSeason: string | null;
  /** Oldest and newest baseline seasons, e.g. ["2015-2016", "2025-2026"]. */
  baselineRange: [string, string] | null;
  /** Set when the season is still under way: rows compare against full seasons except "Opened so far". */
  inProgress: boolean;
  /** Seasons in the baseline (BASELINE_SEASONS unless the data runs out). */
  baselineSeasons: number;
  /** Last season was cut short (2019-20). */
  lastDisrupted: boolean;
  /** This season's or last season's recoupment is still playing out (rows labelled "so far"). */
  recoupUnsettled: boolean;
  /** Day offset into the season used for "Opened so far", null for a finished season. */
  asOfDay: number | null;
  rows: ComparisonRow[];
}

function share(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

/** A share of a small group (nonprofit share, recoupment rate) needs MIN_AVERAGE_SAMPLE shows. */
function sampledShare(n: number, d: number): number | null {
  return d >= MIN_AVERAGE_SAMPLE ? n / d : null;
}

function avgOf(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v != null);
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
}

/** Pooled share across seasons: sum of numerators over sum of denominators. */
function pooled(ps: SeasonProfile[], num: (p: SeasonProfile) => number, den: (p: SeasonProfile) => number): number | null {
  const d = ps.reduce((a, p) => a + den(p), 0);
  return d > 0 ? ps.reduce((a, p) => a + num(p), 0) / d : null;
}

function mean(agg: MoneyAggregate): number | null {
  return agg.known >= MIN_AVERAGE_SAMPLE ? agg.total / agg.known : null;
}

/** Mean across seasons of the money figure, counting only seasons that pass `ok` and have a figure. */
function moneyAvg(ps: SeasonProfile[], ok: (p: SeasonProfile) => boolean, pick: (p: SeasonProfile) => number | null): { avg: number | null; n: number } {
  const vals = ps.filter(ok).map(pick).filter((v): v is number => v != null);
  return { avg: avgOf(vals), n: vals.length };
}

function pctDetail(n: number, d: number): string | null {
  return d > 0 ? `${n} of ${d}` : null;
}

/** "15.4 of 36.2": a pooled share's counts as per-season averages. */
function avgCountDetail(ps: SeasonProfile[], num: (p: SeasonProfile) => number, den: (p: SeasonProfile) => number): string | null {
  if (!ps.length) return null;
  const per = (f: (p: SeasonProfile) => number) => {
    const v = ps.reduce((a, p) => a + f(p), 0) / ps.length;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  return ps.reduce((a, p) => a + den(p), 0) > 0 ? `${per(num)} of ${per(den)}` : null;
}

function disclosedDetail(agg: MoneyAggregate): string | null {
  return agg.of > 0 ? `${agg.known} of ${agg.of} disclosed` : null;
}

/**
 * The BASELINE_SEASONS seasons before `season` with openings, pandemic
 * seasons left out, and the season just before it (even if disrupted; 2020-21
 * had no openings at all). Newest first.
 */
export function seasonBaseline(profiles: SeasonProfile[], season: string): { baseline: SeasonProfile[]; last: SeasonProfile | null; prev: SeasonProfile | null } {
  const sorted = [...profiles].sort((a, b) => b.season.localeCompare(a.season));
  const idx = sorted.findIndex((p) => p.season === season);
  if (idx === -1) return { baseline: [], last: null, prev: null };
  const withOpenings = sorted.slice(idx + 1).filter((p) => p.productions > 0);
  return {
    baseline: withOpenings.filter((p) => !DISRUPTED_SEASONS.has(p.season)).slice(0, BASELINE_SEASONS),
    last: withOpenings[0] ?? null,
    prev: withOpenings[1] ?? null,
  };
}

/**
 * compareSeason rows about the production mix (the public report shows them in
 * its Production Mix card, not the comparison table). One list so a renamed row
 * fails season-profile.test.ts instead of silently reappearing.
 */
export const MIX_ROW_LABELS = [
  'Musicals', 'Revivals (all)', 'Revivals among musicals', 'Revivals among plays',
  'Musicals among originals', 'Musicals among revivals',
] as const;
/** Mix rows the report drops outright ('Plays' is 100% less 'Musicals' less specials). */
export const MIX_ROW_LABELS_HIDDEN = [...MIX_ROW_LABELS, 'Plays'] as const;

/** The four mix groups plus specials, in report order; `id` doubles as the page anchor. */
export const SHOW_GROUPS = [
  { id: 'original-musicals', label: 'Original musicals', one: 'Original musical' },
  { id: 'musical-revivals', label: 'Musical revivals', one: 'Musical revival' },
  { id: 'original-plays', label: 'Original plays', one: 'Original play' },
  { id: 'play-revivals', label: 'Play revivals', one: 'Play revival' },
  { id: 'specials', label: 'Specials and other shows', one: 'Special' },
] as const;
export type ShowGroupId = (typeof SHOW_GROUPS)[number]['id'];

/** The mix group a show counts in, by the same rule as mix(): no revival flag means 'specials'. */
export function showGroup(type: string | null | undefined, isRevival: boolean | null | undefined): ShowGroupId {
  if (typeof isRevival !== 'boolean' || (type !== 'musical' && type !== 'play')) return 'specials';
  if (type === 'musical') return isRevival ? 'musical-revivals' : 'original-musicals';
  return isRevival ? 'play-revivals' : 'original-plays';
}

export interface MixBreakdown {
  originalMusicals: number;
  musicalRevivals: number;
  originalPlays: number;
  playRevivals: number;
  /** Specials, operas, untyped, and musicals/plays with no original/revival flag. */
  other: number;
  total: number;
}

/** The 2x2 of musicals/plays by original/revival; several profiles are summed (pooled). */
export function mix(...ps: SeasonProfile[]): MixBreakdown {
  const m: MixBreakdown = { originalMusicals: 0, musicalRevivals: 0, originalPlays: 0, playRevivals: 0, other: 0, total: 0 };
  for (const p of ps) {
    m.originalMusicals += p.musicalRevivalKnown - p.musicalRevivals;
    m.musicalRevivals += p.musicalRevivals;
    m.originalPlays += p.playRevivalKnown - p.playRevivals;
    m.playRevivals += p.playRevivals;
    m.total += p.productions;
  }
  m.other = m.total - m.originalMusicals - m.musicalRevivals - m.originalPlays - m.playRevivals;
  return m;
}

/**
 * Compare a season with the season before it and the BASELINE_SEASONS seasons
 * before it, leaving out the pandemic seasons (DISRUPTED_SEASONS). Mix shares
 * are pooled. Nonprofit and recoupment rows use only seasons we track well
 * (recoupment: only seasons that have settled); each money row uses only
 * seasons with enough disclosed figures in its own bucket. Rows on fewer
 * seasons say how many.
 */
export function compareSeason(profiles: SeasonProfile[], season: string, asOf: string): SeasonComparison | null {
  const sorted = [...profiles].sort((a, b) => b.season.localeCompare(a.season));
  const idx = sorted.findIndex((p) => p.season === season);
  if (idx === -1) return null;
  const cur = sorted[idx];
  const { baseline, last, prev } = seasonBaseline(sorted, season);

  const asOfMs = Date.parse(asOf);
  const start = seasonStartMs(season);
  const seasonEnd = Date.UTC(parseInt(season.slice(5), 10), 6, 1);
  const inProgress = asOfMs >= start && asOfMs < seasonEnd;
  const asOfDay = inProgress ? Math.floor((asOfMs - start) / DAY_MS) : null;

  const rows: ComparisonRow[] = [];

  // The same cell for last season and the season before it.
  const pair = (cell: (q: SeasonProfile | null) => { v: number | null; d: string | null }) => {
    const l = cell(last);
    const p2 = cell(prev);
    return { last: l.v, lastDetail: l.d, prev: p2.v, prevDetail: p2.d };
  };

  if (asOfDay != null) {
    const openedBy = (p: SeasonProfile) => p.openingDayOffsets.filter((d) => d <= asOfDay).length;
    rows.push({
      label: 'Opened so far',
      format: 'count',
      current: openedBy(cur),
      currentDetail: null,
      ...pair((q) => ({ v: q ? openedBy(q) : null, d: null })),
      avg: avgOf(baseline.map(openedBy)),
      avgDetail: null,
      avgSeasons: baseline.length,
    });
  }

  rows.push({
    label: inProgress ? 'Productions (opened + announced)' : 'New productions',
    format: 'count',
    current: cur.productions,
    currentDetail: null,
    ...pair((q) => ({ v: q?.productions ?? null, d: null })),
    avg: avgOf(baseline.map((p) => p.productions)),
    avgDetail: null,
    avgSeasons: baseline.length,
  });

  const shareRow = (label: string, num: (p: SeasonProfile) => number, den: (p: SeasonProfile) => number) => {
    rows.push({
      label,
      format: 'pct',
      current: share(num(cur), den(cur)),
      currentDetail: pctDetail(num(cur), den(cur)),
      ...pair((q) => ({ v: q ? share(num(q), den(q)) : null, d: q ? pctDetail(num(q), den(q)) : null })),
      avg: pooled(baseline, num, den),
      avgDetail: avgCountDetail(baseline, num, den),
      avgSeasons: baseline.length,
    });
  };
  shareRow('Musicals', (p) => p.musicals, (p) => p.productions);
  shareRow('Plays', (p) => p.plays, (p) => p.productions);
  shareRow('Revivals (all)', (p) => p.revivals, (p) => p.revivalKnown);
  shareRow('Revivals among musicals', (p) => p.musicalRevivals, (p) => p.musicalRevivalKnown);
  shareRow('Revivals among plays', (p) => p.playRevivals, (p) => p.playRevivalKnown);
  // The other way round (owner, 2026-10-20): what each of originals and revivals is made of.
  shareRow('Musicals among originals', (p) => mix(p).originalMusicals, (p) => mix(p).originalMusicals + mix(p).originalPlays);
  shareRow('Musicals among revivals', (p) => p.musicalRevivals, (p) => p.musicalRevivals + p.playRevivals);

  // Nonprofit share and recoupment need commercial.json coverage.
  const tracked = baseline.filter(hasTrackedCoverage);
  const trackedOk = hasTrackedCoverage(cur);
  rows.push({
    label: 'Produced by a nonprofit theater',
    format: 'pct',
    current: trackedOk ? sampledShare(cur.nonprofit, cur.tracked) : null,
    currentDetail: trackedOk ? pctDetail(cur.nonprofit, cur.tracked) : null,
    ...pair((q) => ({ v: q && hasTrackedCoverage(q) ? sampledShare(q.nonprofit, q.tracked) : null, d: q && hasTrackedCoverage(q) ? pctDetail(q.nonprofit, q.tracked) : null })),
    avg: pooled(tracked, (p) => p.nonprofit, (p) => p.tracked),
    avgDetail: avgCountDetail(tracked, (p) => p.nonprofit, (p) => p.tracked),
    avgSeasons: tracked.length,
  });
  // Recoupment keeps rising while a season's shows run, so the average uses
  // settled seasons only and an unsettled season's rate is labelled "so far".
  // A season under way states its rate so far: recouping mid-season is rare, so it is mostly 0%.
  const isSettled = (p: SeasonProfile) => asOfMs - Date.UTC(parseInt(p.season.slice(5), 10), 6, 1) >= RECOUP_SETTLE_DAYS * DAY_MS;
  const settled = tracked.filter(isSettled);
  const recoupUnsettled = !isSettled(cur) || (!!last && !isSettled(last));
  rows.push({
    label: isSettled(cur) ? 'Commercial shows recouped' : 'Commercial shows recouped as of today',
    format: 'pct',
    current: trackedOk || inProgress ? sampledShare(cur.recouped, cur.outcomeKnown) : null,
    currentDetail: trackedOk || inProgress ? pctDetail(cur.recouped, cur.outcomeKnown) : null,
    ...pair((q) => ({ v: q && hasTrackedCoverage(q) ? sampledShare(q.recouped, q.outcomeKnown) : null, d: q && hasTrackedCoverage(q) ? pctDetail(q.recouped, q.outcomeKnown) : null })),
    avg: pooled(settled, (p) => p.recouped, (p) => p.outcomeKnown),
    avgDetail: avgCountDetail(settled, (p) => p.recouped, (p) => p.outcomeKnown),
    avgSeasons: settled.length,
  });

  // Money rows state an average once MIN_AVERAGE_SAMPLE figures are public
  // (owner, 2026-10-21: show what we have, marked), each column saying how
  // many were disclosed. The prior-seasons average takes only seasons we
  // track well that have a figure, and says how many seasons that is.
  const moneyRow = (label: string, agg: (p: SeasonProfile) => MoneyAggregate, slate: (p: SeasonProfile) => number) => {
    const ok = (p: SeasonProfile) => hasTrackedCoverage(p);
    const { avg, n } = moneyAvg(baseline, ok, (p) => mean(agg(p)));
    const used = baseline.filter((p) => ok(p) && mean(agg(p)) != null);
    const a = agg(cur);
    // A season under way is judged against its whole announced bucket: most of it is not in commercial.json yet.
    const curOf = inProgress ? Math.max(a.of, slate(cur)) : a.of;
    rows.push({
      label,
      format: 'money',
      current: trackedOk || inProgress ? mean(a) : null,
      currentDetail: disclosedDetail({ ...a, of: curOf }),
      ...pair((q) => ({ v: q && ok(q) ? mean(agg(q)) : null, d: q && ok(q) ? disclosedDetail(agg(q)) : null })),
      avg,
      avgDetail: used.length ? `${avgCountDetail(used, (p) => agg(p).known, (p) => agg(p).of)} disclosed` : null,
      avgSeasons: n,
    });
  };

  // A sum of disclosed budgets measures how much we found as much as what was
  // spent, so every column says how many budgets it adds up.
  const capAll = (p: SeasonProfile) => p.capitalization.all;
  const capSeasons = baseline.filter((p) => hasTrackedCoverage(p) && capAll(p).known > 0);
  rows.push({
    label: 'Disclosed capitalization (sum)',
    format: 'money',
    whole: true,
    current: capAll(cur).known > 0 ? capAll(cur).total : null,
    currentDetail: disclosedDetail(capAll(cur)),
    ...pair((q) => ({ v: q && hasTrackedCoverage(q) && capAll(q).known > 0 ? capAll(q).total : null, d: q && hasTrackedCoverage(q) ? disclosedDetail(capAll(q)) : null })),
    avg: avgOf(capSeasons.map((p) => capAll(p).total)),
    avgDetail: capSeasons.length ? `${avgCountDetail(capSeasons, (p) => capAll(p).known, (p) => capAll(p).of)} disclosed` : null,
    avgSeasons: capSeasons.length,
  });
  moneyRow('Average capitalization, musical', (p) => p.capitalization.musical, (p) => p.musicals);
  moneyRow('Average capitalization, play', (p) => p.capitalization.play, (p) => p.plays);
  moneyRow('Average weekly running cost, musical', (p) => p.runningCost.musical, (p) => p.musicals);
  moneyRow('Average weekly running cost, play', (p) => p.runningCost.play, (p) => p.plays);

  return {
    season,
    lastSeason: last?.season ?? null,
    prevSeason: prev?.season ?? null,
    baselineRange: baseline.length ? [baseline[baseline.length - 1].season, baseline[0].season] : null,
    inProgress,
    baselineSeasons: baseline.length,
    lastDisrupted: !!last && DISRUPTED_SEASONS.has(last.season),
    recoupUnsettled,
    asOfDay,
    rows,
  };
}

/** Formats a comparison cell: "38%", "$14.2M", "31". */
export function formatRowValue(format: RowFormat, value: number | null, whole = false): string {
  if (value == null) return '—';
  if (format === 'money' && whole) return formatSeasonMoney(value);
  if (format === 'pct') return `${Math.round(value * 100)}%`;
  if (format === 'count') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  // 999,500 and up would round to "$1000K", so it prints as $1.0M.
  if (value >= 999_500) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(value / 1000)}K`;
}

// ============================================
// Who recoups (public Season Report, BRO-5777)
// ============================================

export interface RecoupShowInput extends SeasonShowInput {
  status: string | null | undefined;
  /** Broadway Scorecard critic score (compositeScore), null when unscored. */
  criticScore: number | null | undefined;
  slug?: string;
  title?: string;
}

export interface RecoupBucket {
  label: string;
  recouped: number;
  total: number;
  /** The shows that recouped (named publicly; shows that did not are never listed). */
  recoupedShows: Array<{ slug: string; title: string; year: string }>;
}

export interface ScoreBand {
  recouped: number;
  total: number;
}

export interface RecoupFindings {
  /** Oldest and newest season counted, null when none qualifies. */
  range: [string, string] | null;
  seasonCount: number;
  /** Commercial productions by type and original/revival; still-running shows count, so rates are floors. */
  buckets: RecoupBucket[];
  /** Mean critic score of shows that recouped vs shows that closed without recouping. */
  recoupedAvgScore: number | null;
  recoupedScored: number;
  closedUnrecoupedAvgScore: number | null;
  closedUnrecoupedScored: number;
  /** Among decided shows (recouped, or closed without recouping). */
  under60: ScoreBand;
  atLeast80: ScoreBand;
}

/** Critic score under this reads as a weak review consensus. */
export const LOW_SCORE = 60;
/** Critic score at or above this reads as a strong review consensus. */
export const HIGH_SCORE = 80;

/**
 * Seasons whose recoupment rates can be compared, oldest first: tracked well
 * (hasTrackedCoverage), ended RECOUP_SETTLE_DAYS ago (the same rule as
 * compareSeason's recoupment average), pandemic seasons left out.
 */
export function settledRecoupSeasons(shows: SeasonShowInput[], asOf: string): string[] {
  const asOfMs = Date.parse(asOf);
  return buildSeasonProfiles(shows)
    .filter((p) => hasTrackedCoverage(p) && !DISRUPTED_SEASONS.has(p.season)
      && asOfMs - Date.UTC(parseInt(p.season.slice(5), 10), 6, 1) >= RECOUP_SETTLE_DAYS * DAY_MS)
    .map((p) => p.season)
    .sort();
}

/**
 * Recoupment by show type and by critic score, over settled seasons we
 * track well (hasTrackedCoverage; ended RECOUP_SETTLE_DAYS ago, the same rule
 * as compareSeason's recoupment average), pandemic seasons left out. Pure
 * nonprofit runs and tour stops have no investors and are left out.
 */
export function buildRecoupFindings(shows: RecoupShowInput[], asOf: string): RecoupFindings {
  const sorted = settledRecoupSeasons(shows, asOf);
  const seasons = new Set(sorted);

  const buckets: Record<string, RecoupBucket> = {
    'play|true': { label: 'Play revivals', recouped: 0, total: 0, recoupedShows: [] },
    'play|false': { label: 'Original plays', recouped: 0, total: 0, recoupedShows: [] },
    'musical|true': { label: 'Musical revivals', recouped: 0, total: 0, recoupedShows: [] },
    'musical|false': { label: 'Original musicals', recouped: 0, total: 0, recoupedShows: [] },
  };
  const recScores: number[] = [];
  const lossScores: number[] = [];
  const under60: ScoreBand = { recouped: 0, total: 0 };
  const atLeast80: ScoreBand = { recouped: 0, total: 0 };

  for (const s of shows) {
    const season = getSeason(s.openingDate);
    const c = trackedRecord(s);
    if (!season || !seasons.has(season) || !c || isExcludedFromSeasonStats(c)) continue;
    const recouped = c.recouped === true;
    const b = buckets[`${s.type}|${s.isRevival === true}`];
    if (b && typeof s.isRevival === 'boolean') {
      b.total++;
      if (recouped) {
        b.recouped++;
        if (s.slug && s.title) b.recoupedShows.push({ slug: s.slug, title: s.title, year: s.openingDate.slice(0, 4) });
      }
    }
    const decided = recouped || s.status === 'closed';
    const score = typeof s.criticScore === 'number' ? s.criticScore : null;
    if (!decided || score == null) continue;
    (recouped ? recScores : lossScores).push(score);
    for (const [band, hit] of [[under60, score < LOW_SCORE], [atLeast80, score >= HIGH_SCORE]] as const) {
      if (!hit) continue;
      band.total++;
      if (recouped) band.recouped++;
    }
  }

  const avg = (xs: number[]) => (xs.length >= MIN_AVERAGE_SAMPLE ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  for (const b of Object.values(buckets)) b.recoupedShows.sort((x, y) => x.title.localeCompare(y.title));
  return {
    range: sorted.length ? [sorted[0], sorted[sorted.length - 1]] : null,
    seasonCount: sorted.length,
    buckets: Object.values(buckets),
    recoupedAvgScore: avg(recScores),
    recoupedScored: recScores.length,
    closedUnrecoupedAvgScore: avg(lossScores),
    closedUnrecoupedScored: lossScores.length,
    under60,
    atLeast80,
  };
}

export { formatSeasonMoney };
