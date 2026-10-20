// Season profile for the commercial scorecard (/biz, /biz/season/[season]):
// what a Broadway season opened (plays vs musicals, originals vs revivals),
// what it cost (disclosed capitalization, weekly running cost) and how many
// shows recouped, compared with last season and the 10-season average.
//
// Pure: no data imports. data-commercial.ts feeds it shows.json +
// commercial.json rows; tests/unit/season-profile.test.ts calls it with
// fixtures.

import { getSeason, isExcludedFromSeasonStats } from './commercial-metrics';

export interface SeasonShowInput {
  type: string | null | undefined;
  isRevival: boolean | null | undefined;
  openingDate: string;
  /** commercial.json record, null when the show is not tracked there. */
  commercial: {
    capitalization?: number | null;
    /**
     * Weekly running cost as recorded. Supplied by data-commercial.ts, the
     * approved reader of the running-cost field in commercial data (cost-for-week
     * baseline test); this lib only averages it.
     */
    weeklyCost?: number | null;
    recouped?: boolean | null;
    designation?: string | null;
    productionType?: string | null;
    /** Producing nonprofit (Roundabout, MTC, LCT...), also set on enhancement and converted runs. */
    nonprofitOrg?: string | null;
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
  capitalization: { all: MoneyAggregate; musical: MoneyAggregate; play: MoneyAggregate };
  runningCost: { musical: MoneyAggregate; play: MoneyAggregate };
}

/** Share of productions with a commercial.json record before nonprofit / recoupment rows count. */
export const MIN_TRACKED_SHARE = 0.75;
/** Share of commercial productions with a disclosed capitalization before money rows count. */
export const MIN_CAP_COVERAGE = 0.6;
/** Seasons in the long-run baseline. */
export const BASELINE_SEASONS = 10;
/** Disclosed figures a per-show average needs; fewer is one or two shows, not an average. */
export const MIN_AVERAGE_SAMPLE = 3;
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
    tracked: 0, nonprofit: 0, commercial: 0, recouped: 0,
    capitalization: { all: emptyMoney(), musical: emptyMoney(), play: emptyMoney() },
    runningCost: { musical: emptyMoney(), play: emptyMoney() },
  };
}

/** One profile per season (July 1 - June 30), newest first. */
export function buildSeasonProfiles(shows: SeasonShowInput[]): SeasonProfile[] {
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

    const c = show.commercial;
    if (!c) continue;
    p.tracked++;
    if (c.nonprofitOrg) p.nonprofit++;
    if (isExcludedFromSeasonStats(c)) continue;
    p.commercial++;
    if (c.recouped === true) p.recouped++;
    addMoney(p.capitalization.all, c.capitalization);
    if (isMusical) {
      addMoney(p.capitalization.musical, c.capitalization);
      addMoney(p.runningCost.musical, c.weeklyCost);
    } else if (isPlay) {
      addMoney(p.capitalization.play, c.capitalization);
      addMoney(p.runningCost.play, c.weeklyCost);
    }
  }
  return Array.from(bySeason.values()).sort((a, b) => b.season.localeCompare(a.season));
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

/** Enough disclosed figures in this one bucket (each money row is gated on its own field). */
function hasMoneyCoverage(agg: MoneyAggregate, min = MIN_CAP_COVERAGE): boolean {
  return agg.of > 0 && agg.known / agg.of >= min;
}

export type RowFormat = 'count' | 'pct' | 'money';

export interface ComparisonRow {
  label: string;
  format: RowFormat;
  current: number | null;
  /** "12 of 32" style detail for the current season. */
  currentDetail: string | null;
  last: number | null;
  avg: number | null;
  /** Seasons the average is taken over (fewer than BASELINE_SEASONS for money and recoupment rows). */
  avgSeasons: number;
}

export interface SeasonComparison {
  season: string;
  lastSeason: string | null;
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

/**
 * The BASELINE_SEASONS seasons before `season` with openings, pandemic
 * seasons left out, and the season just before it (even if disrupted; 2020-21
 * had no openings at all). Newest first.
 */
export function seasonBaseline(profiles: SeasonProfile[], season: string): { baseline: SeasonProfile[]; last: SeasonProfile | null } {
  const sorted = [...profiles].sort((a, b) => b.season.localeCompare(a.season));
  const idx = sorted.findIndex((p) => p.season === season);
  if (idx === -1) return { baseline: [], last: null };
  return {
    baseline: sorted.slice(idx + 1).filter((p) => p.productions > 0 && !DISRUPTED_SEASONS.has(p.season)).slice(0, BASELINE_SEASONS),
    last: sorted.slice(idx + 1).find((p) => p.productions > 0) ?? null,
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
  const { baseline, last } = seasonBaseline(sorted, season);

  const asOfMs = Date.parse(asOf);
  const start = seasonStartMs(season);
  const seasonEnd = Date.UTC(parseInt(season.slice(5), 10), 6, 1);
  const inProgress = asOfMs >= start && asOfMs < seasonEnd;
  const asOfDay = inProgress ? Math.floor((asOfMs - start) / DAY_MS) : null;

  const rows: ComparisonRow[] = [];

  if (asOfDay != null) {
    const openedBy = (p: SeasonProfile) => p.openingDayOffsets.filter((d) => d <= asOfDay).length;
    rows.push({
      label: 'Opened so far',
      format: 'count',
      current: openedBy(cur),
      currentDetail: null,
      last: last ? openedBy(last) : null,
      avg: avgOf(baseline.map(openedBy)),
      avgSeasons: baseline.length,
    });
  }

  rows.push({
    label: inProgress ? 'Productions (opened + announced)' : 'New productions',
    format: 'count',
    current: cur.productions,
    currentDetail: null,
    last: last?.productions ?? null,
    avg: avgOf(baseline.map((p) => p.productions)),
    avgSeasons: baseline.length,
  });

  const shareRow = (label: string, num: (p: SeasonProfile) => number, den: (p: SeasonProfile) => number) => {
    rows.push({
      label,
      format: 'pct',
      current: share(num(cur), den(cur)),
      currentDetail: pctDetail(num(cur), den(cur)),
      last: last ? share(num(last), den(last)) : null,
      avg: pooled(baseline, num, den),
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
    last: last && hasTrackedCoverage(last) ? sampledShare(last.nonprofit, last.tracked) : null,
    avg: pooled(tracked, (p) => p.nonprofit, (p) => p.tracked),
    avgSeasons: tracked.length,
  });
  // Recoupment keeps rising while a season's shows run, so the average uses
  // settled seasons only and an unsettled season's rate is labelled "so far".
  // A season under way gets its count, not a rate, unless we track most of it.
  const isSettled = (p: SeasonProfile) => asOfMs - Date.UTC(parseInt(p.season.slice(5), 10), 6, 1) >= RECOUP_SETTLE_DAYS * DAY_MS;
  const settled = tracked.filter(isSettled);
  const recoupUnsettled = !isSettled(cur) || (!!last && !isSettled(last));
  rows.push({
    label: isSettled(cur) ? 'Commercial shows recouped' : 'Commercial shows recouped so far',
    format: 'pct',
    current: trackedOk ? sampledShare(cur.recouped, cur.commercial) : null,
    currentDetail: trackedOk || inProgress ? pctDetail(cur.recouped, cur.commercial) : null,
    last: last && hasTrackedCoverage(last) ? sampledShare(last.recouped, last.commercial) : null,
    avg: pooled(settled, (p) => p.recouped, (p) => p.commercial),
    avgSeasons: settled.length,
  });

  // Each money row is gated on its own bucket's coverage. A season under way
  // is judged against its whole announced bucket (`slate`): most of it is not
  // in commercial.json yet, so `agg.of` would overstate coverage.
  const moneyRow = (label: string, agg: (p: SeasonProfile) => MoneyAggregate, slate: (p: SeasonProfile) => number) => {
    const ok = (p: SeasonProfile) => hasTrackedCoverage(p) && hasMoneyCoverage(agg(p));
    const { avg, n } = moneyAvg(baseline, ok, (p) => mean(agg(p)));
    const a = agg(cur);
    const curOf = inProgress ? Math.max(a.of, slate(cur)) : a.of;
    const curOk = (trackedOk || inProgress) && hasMoneyCoverage({ ...a, of: curOf });
    rows.push({
      label,
      format: 'money',
      current: curOk ? mean(a) : null,
      currentDetail: curOf > 0 ? `${a.known} of ${curOf} disclosed` : null,
      last: last && ok(last) ? mean(agg(last)) : null,
      avg,
      avgSeasons: n,
    });
  };

  // A sum of disclosed budgets measures how much we found as much as what was
  // spent: it is stated for the season, and compared only between seasons
  // where nearly every budget is public.
  const capAll = (p: SeasonProfile) => p.capitalization.all;
  const fullCap = (p: SeasonProfile) => hasTrackedCoverage(p) && hasMoneyCoverage(capAll(p), MIN_TOTAL_COVERAGE);
  // A season under way is a partial slate: its sum is stated, never compared.
  const curFull = !inProgress && fullCap(cur);
  const fullBaseline = curFull ? baseline.filter(fullCap) : [];
  rows.push({
    label: 'Disclosed capitalization (sum)',
    format: 'money',
    current: cur.capitalization.all.known > 0 ? cur.capitalization.all.total : null,
    currentDetail: cur.capitalization.all.of > 0 ? `${cur.capitalization.all.known} of ${cur.capitalization.all.of} disclosed` : null,
    last: curFull && last && fullCap(last) ? last.capitalization.all.total : null,
    avg: avgOf(fullBaseline.map((p) => p.capitalization.all.total)),
    avgSeasons: fullBaseline.length,
  });
  moneyRow('Average capitalization, musical', (p) => p.capitalization.musical, (p) => p.musicals);
  moneyRow('Average capitalization, play', (p) => p.capitalization.play, (p) => p.plays);
  moneyRow('Average weekly running cost, musical', (p) => p.runningCost.musical, (p) => p.musicals);
  moneyRow('Average weekly running cost, play', (p) => p.runningCost.play, (p) => p.plays);

  return {
    season,
    lastSeason: last?.season ?? null,
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
export function formatRowValue(format: RowFormat, value: number | null): string {
  if (value == null) return '—';
  if (format === 'pct') return `${Math.round(value * 100)}%`;
  if (format === 'count') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(value / 1000)}K`;
}

// ============================================
// Who recoups (public Season Report, BRO-5777)
// ============================================

export interface RecoupShowInput extends SeasonShowInput {
  status: string | null | undefined;
  /** Broadway Scorecard critic score (compositeScore), null when unscored. */
  criticScore: number | null | undefined;
}

export interface RecoupBucket {
  label: string;
  recouped: number;
  total: number;
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
 * Recoupment by show type and by critic score, over settled seasons we
 * track well (hasTrackedCoverage; ended RECOUP_SETTLE_DAYS ago, the same rule
 * as compareSeason's recoupment average), pandemic seasons left out. Pure
 * nonprofit runs and tour stops have no investors and are left out.
 */
export function buildRecoupFindings(shows: RecoupShowInput[], asOf: string): RecoupFindings {
  const profiles = buildSeasonProfiles(shows);
  const asOfMs = Date.parse(asOf);
  const seasons = new Set(
    profiles
      .filter((p) => hasTrackedCoverage(p) && !DISRUPTED_SEASONS.has(p.season)
        && asOfMs - Date.UTC(parseInt(p.season.slice(5), 10), 6, 1) >= RECOUP_SETTLE_DAYS * DAY_MS)
      .map((p) => p.season),
  );
  const sorted = [...seasons].sort();

  const buckets: Record<string, RecoupBucket> = {
    'play|true': { label: 'Play revivals', recouped: 0, total: 0 },
    'play|false': { label: 'Original plays', recouped: 0, total: 0 },
    'musical|true': { label: 'Musical revivals', recouped: 0, total: 0 },
    'musical|false': { label: 'Original musicals', recouped: 0, total: 0 },
  };
  const recScores: number[] = [];
  const lossScores: number[] = [];
  const under60: ScoreBand = { recouped: 0, total: 0 };
  const atLeast80: ScoreBand = { recouped: 0, total: 0 };

  for (const s of shows) {
    const season = getSeason(s.openingDate);
    if (!season || !seasons.has(season) || !s.commercial || isExcludedFromSeasonStats(s.commercial)) continue;
    const recouped = s.commercial.recouped === true;
    const b = buckets[`${s.type}|${s.isRevival === true}`];
    if (b && typeof s.isRevival === 'boolean') {
      b.total++;
      if (recouped) b.recouped++;
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
