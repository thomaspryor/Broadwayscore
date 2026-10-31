// Aggregates behind the Profitability Scorecard topic pages (/biz/musicals-since-reopening,
// /biz/reviews-and-money; BRO-5865). Commercial productions only (investors to
// repay: isExcludedFromSeasonStats leaves out nonprofit runs and tour stops),
// Broadway openings from Sep 2021 on.
//
// Pure: no data imports. data-commercial.ts feeds it shows.json + commercial.json
// + canonical critic scores + audience buzz; tests/unit/investment-topics.test.ts
// calls it with fixtures. No model figures here (BRO-5849: a topic total mixes
// many shows, so it sums only published figures): the only range shown is the analyst's, through
// displaysAnalyst / analystRange (model-display-guard).

import { calculateWeeksToRecoup, isExcludedFromSeasonStats } from './commercial-metrics';
import { isLossDesignation } from '../../scripts/lib/commercial-designations';
import { analystRange, displaysAnalyst } from '../../scripts/lib/model-display-guard';

/** First opening counted: Broadway reopened in September 2021. */
export const REOPENING_START = '2021-09-01';

/** Score cut-offs shared by both pages. */
export const BAND_HIGH = 80;
export const BAND_LOW = 70;

export interface TopicCommercial {
  designation?: string | null;
  productionType?: string | null;
  recouped?: boolean | null;
  /** YYYY-MM. */
  recoupedDate?: string | null;
  analystRecoupPct?: unknown;
  capitalization?: number | null;
}

/** Tony record for a show whose ceremony has been held. */
export interface TopicTony {
  nominations: number;
  /** Won at least one Tony. */
  won: boolean;
  /** Nominated for Best Musical/Play or Best Revival of a Musical/Play. */
  topNominated: boolean;
  topWon: boolean;
  /** Tony season (YYYY-YY). */
  season: string | null;
  /** Won Best Musical or Best Play (new work only, not the revival categories). */
  bestNewWon: 'Best Musical' | 'Best Play' | null;
}

export interface TopicShowInput {
  id?: string;
  slug: string;
  title: string;
  type: string | null | undefined;
  isRevival: boolean | null | undefined;
  tags?: string[] | null;
  openingDate: string;
  closingDate?: string | null;
  status: string | null | undefined;
  /** Canonical Critic Score (getCriticScore), null when unscored. */
  criticScore: number | null | undefined;
  /** Audience buzz combined score, null when none. */
  audienceScore: number | null | undefined;
  commercial: TopicCommercial | null;
  /** null when the show has no Tony record (ceremony not held yet, or none found). */
  tony?: TopicTony | null;
}

const TOP_CATEGORIES = new Set(['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play']);

/** Reads a Tony record from awards.json. No nominations count and no nominatedFor list (ceremony not held yet) gives null; a list without a count is a decided season, counted by its length. */
export function tonyFromAwards(tony: { season?: unknown; nominations?: unknown; nominatedFor?: unknown; wins?: unknown } | null | undefined): TopicTony | null {
  if (!tony) return null;
  const list = (x: unknown) => (Array.isArray(x) ? (x as string[]) : []);
  const noms = list(tony.nominatedFor);
  const count = typeof tony.nominations === 'number' ? tony.nominations : Array.isArray(tony.nominatedFor) ? noms.length : null;
  if (count === null) return null;
  const wins = list(tony.wins);
  return {
    nominations: count,
    won: wins.length > 0,
    topNominated: noms.some((c) => TOP_CATEGORIES.has(c)),
    topWon: wins.some((c) => TOP_CATEGORIES.has(c)),
    season: typeof tony.season === 'string' ? tony.season : null,
    bestNewWon: wins.includes('Best Musical') ? 'Best Musical' : wins.includes('Best Play') ? 'Best Play' : null,
  };
}

export type MusicalKind = 'original' | 'revival' | 'pop-catalog';
export type MusicalOutcome = 'recouped' | 'lost' | 'running' | 'unknown';

export const MUSICAL_KIND_SHORT: Record<MusicalKind, string> = { original: 'Original', 'pop-catalog': 'Pop-catalog', revival: 'Revival' };

export const MUSICAL_KIND_LABELS: Record<MusicalKind, string> = {
  original: 'Original musicals',
  'pop-catalog': 'Pop-catalog musicals',
  revival: 'Musical revivals',
};

/** Original, revival, or pop-catalog (tagged jukebox; a revival stays a revival). */
export function musicalKind(s: Pick<TopicShowInput, 'isRevival' | 'tags'>): MusicalKind {
  if (s.isRevival === true) return 'revival';
  return (s.tags ?? []).includes('jukebox') ? 'pop-catalog' : 'original';
}

/** Recouped, lost (Fizzle, Did Not Recoup, Flop), still running, or closed with no verdict (TBD, and Wait & See, which may still pay back). */
export function outcomeOf(s: Pick<TopicShowInput, 'status' | 'commercial'>): MusicalOutcome {
  const c = s.commercial;
  if (c?.recouped === true) return 'recouped';
  if (c && isLossDesignation(c.designation)) return 'lost';
  return s.status === 'closed' ? 'unknown' : 'running';
}

/** Opened on Broadway since the reopening, with investors to repay. */
export function inTopicScope(s: TopicShowInput, asOf: string): boolean {
  if (!s.commercial || isExcludedFromSeasonStats(s.commercial)) return false;
  if (!s.openingDate || s.openingDate < REOPENING_START || s.openingDate > asOf) return false;
  return s.status === 'open' || s.status === 'closed';
}

export interface MusicalRow {
  slug: string;
  title: string;
  kind: MusicalKind;
  outcome: MusicalOutcome;
  openingDate: string;
  designation: string | null;
  /** Months from opening to the recoupment report (recouped shows only). */
  monthsToRecoup: number | null;
  /** The analyst's [low, high] % returned, running shows only, when the site displays it. */
  analystRange: [number, number] | null;
  /** The range is our own estimate (ourEstimateRangePct), not an analyst's. */
  rangeIsOurs?: boolean;
}

export interface KindSummary {
  kind: MusicalKind;
  label: string;
  total: number;
  recouped: number;
  lost: number;
  running: number;
  unknown: number;
}

export interface MusicalsSinceReopening {
  since: string;
  rows: MusicalRow[];
  summaries: KindSummary[];
  total: number;
  recouped: number;
  /** Every musical that is not a revival (originals plus pop-catalog): the "originals" headline. */
  originals: KindSummary;
  /** Median months to recoup across musicals that recouped with a measurable date. */
  medianMonthsToRecoup: number | null;
  /** How many recouped musicals the median rests on. */
  medianSample: number;
}

function monthsBetween(from: string, to: string | null | undefined, closingDate: string | null | undefined, asOf: string): number | null {
  const weeks = calculateWeeksToRecoup(from, to, closingDate, new Date(asOf));
  return weeks == null ? null : Math.round((weeks * 7) / 30.44);
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Every commercial musical opened Sep 2021 to asOf, with its outcome. */
export function buildMusicalsSinceReopening(shows: TopicShowInput[], asOf: string): MusicalsSinceReopening {
  const rows: MusicalRow[] = shows
    .filter((s) => s.type === 'musical' && inTopicScope(s, asOf))
    .map((s) => {
      const outcome = outcomeOf(s);
      // A [0, 0] range is a placeholder for a show too new to size, not an estimate.
      const shown = outcome === 'running' && displaysAnalyst(s.commercial, { status: s.status }) ? analystRange(s.commercial) : null;
      const range = shown && shown[1] > 0 ? shown : null;
      return {
        slug: s.slug,
        title: s.title,
        kind: musicalKind(s),
        outcome,
        openingDate: s.openingDate,
        designation: s.commercial?.designation ?? null,
        monthsToRecoup: outcome === 'recouped' ? monthsBetween(s.openingDate, s.commercial?.recoupedDate, s.closingDate, asOf) : null,
        analystRange: range,
        ...(range && !s.commercial?.analystRecoupPct ? { rangeIsOurs: true } : {}),
      };
    })
    .sort((a, b) => b.openingDate.localeCompare(a.openingDate) || a.title.localeCompare(b.title));

  const summaries = (Object.keys(MUSICAL_KIND_LABELS) as MusicalKind[]).map((kind): KindSummary => {
    const rs = rows.filter((r) => r.kind === kind);
    const n = (o: MusicalOutcome) => rs.filter((r) => r.outcome === o).length;
    return { kind, label: MUSICAL_KIND_LABELS[kind], total: rs.length, recouped: n('recouped'), lost: n('lost'), running: n('running'), unknown: n('unknown') };
  });
  const nonRevival = summaries.filter((x) => x.kind !== 'revival');
  const sum = (f: (x: KindSummary) => number) => nonRevival.reduce((a, x) => a + f(x), 0);
  const originals: KindSummary = {
    kind: 'original',
    label: 'Original musicals (including pop-catalog)',
    total: sum((x) => x.total), recouped: sum((x) => x.recouped), lost: sum((x) => x.lost), running: sum((x) => x.running), unknown: sum((x) => x.unknown),
  };
  return {
    since: REOPENING_START,
    rows,
    summaries,
    total: rows.length,
    recouped: rows.filter((r) => r.outcome === 'recouped').length,
    originals,
    medianMonthsToRecoup: median(rows.flatMap((r) => (r.monthsToRecoup == null ? [] : [r.monthsToRecoup]))),
    medianSample: rows.filter((r) => r.monthsToRecoup != null).length,
  };
}

// ---------------------------------------------------------------------------
// What predicts the money (one panel per bucket)
// ---------------------------------------------------------------------------

export type ScoreBandId = 'high' | 'mid' | 'low';

export const SCORE_BAND_LABELS: Record<ScoreBandId, string> = {
  high: `Critic score ${BAND_HIGH}+`,
  mid: `Critic score ${BAND_LOW} to ${BAND_HIGH - 1}`,
  low: `Critic score under ${BAND_LOW}`,
};

export function scoreBand(score: number): ScoreBandId {
  return score >= BAND_HIGH ? 'high' : score >= BAND_LOW ? 'mid' : 'low';
}

export interface BandCount {
  recouped: number;
  total: number;
}

export type BucketId = 'new-musical' | 'musical-revival' | 'new-play' | 'play-revival';

export const BUCKET_LABELS: Record<BucketId, string> = {
  'new-musical': 'New musicals',
  'musical-revival': 'Musical revivals',
  'new-play': 'New plays',
  'play-revival': 'Play revivals',
};

/** Musical or play, new or revival; other types (special, etc.) are left out. */
export function bucketOf(s: Pick<TopicShowInput, 'type' | 'isRevival'>): BucketId | null {
  if (s.type !== 'musical' && s.type !== 'play') return null;
  const revival = s.isRevival === true;
  return s.type === 'musical' ? (revival ? 'musical-revival' : 'new-musical') : (revival ? 'play-revival' : 'new-play');
}

/** Tony nominations at or above this count as a heavy nomination haul. */
export const TONY_NOMS_HIGH = 5;

export interface BucketStats {
  id: BucketId;
  label: string;
  /** Decided shows: recouped, or closed with a loss label. */
  decided: number;
  recouped: number;
  critic: Record<ScoreBandId, BandCount>;
  audienceUnder70: BandCount;
  audienceAtLeast70: BandCount;
  /** Decided shows with a Tony record only. */
  tonyNoms: { high: BandCount; low: BandCount };
  tonyWin: { won: BandCount; none: BandCount };
  tonyTop: { won: BandCount; nominatedOnly: BandCount; none: BandCount };
}

export interface MoneyCallout {
  slug: string;
  title: string;
  score: number;
  year: string;
  weeksToRecoup: number | null;
}

export interface WhatPredictsTheMoney {
  since: string;
  buckets: BucketStats[];
  /** Lowest critic scores among shows that recouped. */
  lowScoreRecouped: MoneyCallout[];
  /** Highest critic scores among shows that closed at a loss. */
  acclaimedLosers: MoneyCallout[];
}

const LOW_CALLOUTS = 3;
const LOSER_CALLOUTS = 5;

/**
 * Critic, audience and Tony results against recoupment, per bucket (never pooled).
 * Decided shows only: a running show, or one closed with no verdict, has no outcome.
 */
export function buildWhatPredictsTheMoney(shows: TopicShowInput[], asOf: string): WhatPredictsTheMoney {
  const decided = shows.filter((s) => bucketOf(s) && inTopicScope(s, asOf) && ['recouped', 'lost'].includes(outcomeOf(s)));
  const empty = (): BandCount => ({ recouped: 0, total: 0 });
  const buckets = (Object.keys(BUCKET_LABELS) as BucketId[]).map((id): BucketStats => {
    const b: BucketStats = {
      id,
      label: BUCKET_LABELS[id],
      decided: 0,
      recouped: 0,
      critic: { high: empty(), mid: empty(), low: empty() },
      audienceUnder70: empty(),
      audienceAtLeast70: empty(),
      tonyNoms: { high: empty(), low: empty() },
      tonyWin: { won: empty(), none: empty() },
      tonyTop: { won: empty(), nominatedOnly: empty(), none: empty() },
    };
    for (const s of decided.filter((d) => bucketOf(d) === id)) {
      const rec = outcomeOf(s) === 'recouped';
      const bump = (c: BandCount) => { c.total++; if (rec) c.recouped++; };
      b.decided++;
      if (rec) b.recouped++;
      if (typeof s.criticScore === 'number') bump(b.critic[scoreBand(s.criticScore)]);
      if (typeof s.audienceScore === 'number') bump(s.audienceScore < BAND_LOW ? b.audienceUnder70 : b.audienceAtLeast70);
      const t = s.tony;
      if (t) {
        bump(t.nominations >= TONY_NOMS_HIGH ? b.tonyNoms.high : b.tonyNoms.low);
        bump(t.won ? b.tonyWin.won : b.tonyWin.none);
        bump(t.topWon ? b.tonyTop.won : t.topNominated ? b.tonyTop.nominatedOnly : b.tonyTop.none);
      }
    }
    return b;
  });

  const callout = (s: TopicShowInput): MoneyCallout => ({
    slug: s.slug,
    title: s.title,
    score: s.criticScore as number,
    year: s.openingDate.slice(0, 4),
    weeksToRecoup: s.commercial?.recouped === true ? calculateWeeksToRecoup(s.openingDate, s.commercial.recoupedDate, s.closingDate, new Date(asOf)) : null,
  });
  const scored = decided.filter((s) => typeof s.criticScore === 'number');
  const byTitle = (a: TopicShowInput, b: TopicShowInput) => a.title.localeCompare(b.title);
  return {
    since: REOPENING_START,
    buckets,
    lowScoreRecouped: scored.filter((s) => outcomeOf(s) === 'recouped')
      .sort((a, b) => (a.criticScore as number) - (b.criticScore as number) || byTitle(a, b)).slice(0, LOW_CALLOUTS).map(callout),
    acclaimedLosers: scored.filter((s) => outcomeOf(s) === 'lost')
      .sort((a, b) => (b.criticScore as number) - (a.criticScore as number) || byTitle(a, b)).slice(0, LOSER_CALLOUTS).map(callout),
  };
}

// ---------------------------------------------------------------------------
// Biggest flops and fastest recoups
// ---------------------------------------------------------------------------

export interface FlopRow {
  slug: string;
  title: string;
  year: string;
  designation: string;
  /** Capital raised (reported or estimated by the site); the money at stake, not a computed loss. */
  capitalization: number;
  type: 'musical' | 'play';
  /** Shared rank: shows with equal capitalization have the same rank. */
  rank: number;
}

export interface RecoupRow {
  slug: string;
  title: string;
  year: string;
  type: 'musical' | 'play';
  weeksToRecoup: number;
  capitalization: number | null;
  /** Shared rank: shows with equal weeks have the same rank. */
  rank: number;
}

export interface FlopsAndRecoups {
  since: string;
  /** Shows with a loss label (Fizzle, Flop, Did Not Recoup) and a known capitalization, largest first. */
  flops: FlopRow[];
  /** Loss-labelled shows with no capitalization on file (left out of the ranking). */
  flopsWithoutCapitalization: number;
  /** Recouped shows with a measurable opening-to-recoup time, fastest first. */
  recoups: RecoupRow[];
  recoupsWithoutDate: number;
}

const RANKED = 10;

/** Minimum shows in a bucket before a rate is shown as a percentage. */
export const MIN_RATE_SAMPLE = 5;

/** Adds shared ranks (1, 2, 2, 4) and keeps the first n rows plus any rows tied with the last one. Rows must already be sorted by valueOf. */
export function rankWithTies<T>(rows: T[], valueOf: (r: T) => number, n: number): Array<T & { rank: number }> {
  const ranked = rows.map((r, i) => {
    let first = i;
    while (first > 0 && valueOf(rows[first - 1]) === valueOf(r)) first--;
    return { ...r, rank: first + 1 };
  });
  return ranked.filter((r) => r.rank <= n);
}

/** Biggest loss-labelled shows by capitalization, and fastest recoupments by weeks from opening. Commercial shows since the reopening. */
export function buildFlopsAndRecoups(shows: TopicShowInput[], asOf: string): FlopsAndRecoups {
  const scoped = shows.filter((s) => bucketOf(s) && inTopicScope(s, asOf));
  const typeOf = (s: TopicShowInput) => s.type as 'musical' | 'play';
  const lost = scoped.filter((s) => outcomeOf(s) === 'lost');
  const capOf = (s: TopicShowInput) => s.commercial?.capitalization;
  const flops = lost
    .filter((s) => typeof capOf(s) === 'number' && (capOf(s) as number) > 0)
    .map((s): FlopRow => ({ slug: s.slug, title: s.title, year: s.openingDate.slice(0, 4), designation: s.commercial?.designation as string, capitalization: capOf(s) as number, type: typeOf(s), rank: 0 }))
    .sort((a, b) => b.capitalization - a.capitalization || a.title.localeCompare(b.title));
  const recouped = scoped.filter((s) => outcomeOf(s) === 'recouped');
  const timed = recouped.flatMap((s) => {
    const w = calculateWeeksToRecoup(s.openingDate, s.commercial?.recoupedDate, s.closingDate, new Date(asOf));
    return w == null ? [] : [{ s, w }];
  });
  const recoups = timed
    .map(({ s, w }): RecoupRow => ({ slug: s.slug, title: s.title, year: s.openingDate.slice(0, 4), type: typeOf(s), weeksToRecoup: w, capitalization: typeof capOf(s) === 'number' ? (capOf(s) as number) : null, rank: 0 }))
    .sort((a, b) => a.weeksToRecoup - b.weeksToRecoup || a.title.localeCompare(b.title));
  return {
    since: REOPENING_START,
    flops: rankWithTies(flops, (f) => f.capitalization, RANKED),
    flopsWithoutCapitalization: lost.length - flops.length,
    recoups: rankWithTies(recoups, (r) => r.weeksToRecoup, RANKED),
    recoupsWithoutDate: recouped.length - timed.length,
  };
}

// ---------------------------------------------------------------------------
// Tony winners
// ---------------------------------------------------------------------------

export interface TonyWinnerRow {
  slug: string;
  title: string;
  season: string;
  award: 'Best Musical' | 'Best Play';
  outcome: MusicalOutcome;
  designation: string | null;
  monthsToRecoup: number | null;
  capitalization: number | null;
}

export interface TonyWinners {
  rows: TonyWinnerRow[];
  recouped: number;
  /** Winners with a verdict (recouped or lost). */
  decided: number;
}

/** First Tony season counted: the 2021-22 ceremony, the first after the reopening. */
export const FIRST_TONY_SEASON = '2021-22';

/** Best Musical and Best Play winners since 2021-22 (commercial shows) and how the money turned out, newest season first. */
export function buildTonyWinners(shows: TopicShowInput[], asOf: string): TonyWinners {
  const rows = shows
    .filter((s) => s.tony?.bestNewWon && (s.tony.season ?? '') >= FIRST_TONY_SEASON && inTopicScope(s, asOf))
    .map((s): TonyWinnerRow => {
      const outcome = outcomeOf(s);
      return {
        slug: s.slug,
        title: s.title,
        season: s.tony?.season as string,
        award: s.tony?.bestNewWon as 'Best Musical' | 'Best Play',
        outcome,
        designation: s.commercial?.designation ?? null,
        monthsToRecoup: outcome === 'recouped' ? monthsBetween(s.openingDate, s.commercial?.recoupedDate, s.closingDate, asOf) : null,
        capitalization: typeof s.commercial?.capitalization === 'number' ? s.commercial.capitalization : null,
      };
    })
    .sort((a, b) => b.season.localeCompare(a.season) || a.award.localeCompare(b.award));
  return {
    rows,
    recouped: rows.filter((r) => r.outcome === 'recouped').length,
    decided: rows.filter((r) => r.outcome === 'recouped' || r.outcome === 'lost').length,
  };
}

/** $22.5M style capital figure. */
export function formatMillions(n: number): string {
  const m = n / 1_000_000;
  return `$${Number.isInteger(m) ? m : m.toFixed(m < 10 ? 2 : 1).replace(/0$/, '')}M`;
}
