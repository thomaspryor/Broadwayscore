// Path to Broadway (BRO-5842): how productions reached Broadway and what they
// were based on, and how often each kind recouped. Pure: data-commercial.ts
// feeds it shows.json + commercial.json rows and data/show-origins.json
// (written by scripts/classify-show-origins.js, whose lib holds the same codes).

import { getSeason, isExcludedFromSeasonStats } from './commercial-metrics';
import { MIN_AVERAGE_SAMPLE, settledRecoupSeasons, trackedRecord, type RecoupShowInput } from './season-profile';

export type PathStage = 'regional-us' | 'off-broadway' | 'london' | 'international';
export type SourceType = 'film' | 'tv' | 'book' | 'play' | 'music-catalog' | 'other' | 'original';

export interface OriginRecord {
  path: PathStage[];
  pathNote: string | null;
  source: SourceType;
  sourceTitle: string | null;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  originalKind?: OriginalKind | null;
  originalKindNote?: string | null;
}

export const ROUTE_BUCKETS = [
  { id: 'direct', label: 'Straight to Broadway' },
  { id: 'off-broadway', label: 'Off-Broadway first' },
  { id: 'regional-us', label: 'US regional or tryout first' },
  { id: 'london', label: 'London first' },
  { id: 'international', label: 'Other country first' },
  { id: 'multiple', label: 'Two or more stops' },
] as const;
export type RouteBucketId = (typeof ROUTE_BUCKETS)[number]['id'];

export const SOURCE_BUCKETS = [
  { id: 'screen', label: 'Movie or TV' },
  { id: 'book', label: 'Book' },
  { id: 'music-catalog', label: 'Song catalog (jukebox)' },
  { id: 'other', label: 'Other adaptation' },
  { id: 'true-story', label: 'Original: true story' },
  { id: 'invented', label: 'Original: invented story' },
] as const;
export type SourceBucketId = (typeof SOURCE_BUCKETS)[number]['id'];

/** Stops a production can pass through, for "ever played X" counts. */
export const STAGE_LABELS: Record<PathStage, string> = {
  'off-broadway': 'Off-Broadway',
  'regional-us': 'US regional or tryout',
  london: 'London',
  international: 'Other country',
};

export function routeBucket(path: PathStage[]): RouteBucketId {
  if (!path.length) return 'direct';
  return path.length === 1 ? path[0] : 'multiple';
}

export type OriginalKind = 'true-story' | 'invented';

/** Original works split by story: about real people or events, or made up (BRO-5871). Unlabeled originals count as invented. */
export function sourceBucket(source: SourceType, originalKind?: OriginalKind | null): SourceBucketId {
  if (source === 'film' || source === 'tv') return 'screen';
  if (source === 'play' || source === 'other') return 'other';
  if (source === 'original') return originalKind === 'true-story' ? 'true-story' : 'invented';
  return source;
}

/** Decades the mix is shown by; a production counts in the one its season starts in. */
export const ERAS = [
  { id: '2000s', label: '2000-01 to 2009-10', short: "'00-01 to '09-10", from: 2000, to: 2009 },
  { id: '2010s', label: '2010-11 to 2019-20', short: "'10-11 to '19-20", from: 2010, to: 2019 },
  { id: '2020s', label: '2020-21 on', short: "'20-21 to now", from: 2020, to: 9999 },
] as const;

export interface RateCell {
  recouped: number;
  total: number;
  /** Shows that recouped (named publicly; shows that did not are never listed). */
  recoupedShows: Array<{ slug: string; title: string; year: string }>;
}

export interface RecoupRow<Id extends string> {
  id: Id;
  label: string;
  musicals: RateCell;
  plays: RateCell;
  all: RateCell;
}

export interface MixRow<Id extends string> {
  id: Id;
  label: string;
  /** Count per era, same order as ERAS. */
  counts: number[];
  /** Count in the current season alone (also inside the last era). */
  current: number;
}

export interface OriginFindings {
  /** New (non-revival) Broadway productions with an origin record. */
  newProductions: number;
  musicals: number;
  plays: number;
  /** Shows per era, same order as ERAS, for turning MixRow counts into shares. */
  eraTotals: number[];
  routeMix: Array<MixRow<RouteBucketId>>;
  sourceMix: Array<MixRow<SourceBucketId>>;
  /** Share of new productions (all eras) that passed through each stop at any point. */
  everPlayed: Array<{ stage: PathStage; label: string; count: number }>;
  /** Musicals by source, per era, the adaptation trend most people ask about. */
  musicalSourceMix: Array<MixRow<SourceBucketId>>;
  musicalEraTotals: number[];
  /** The season asOf falls in (e.g. "2026-2027"), with its totals for the extra column (opened + announced new productions). */
  currentSeason: string | null;
  currentTotal: number;
  musicalCurrentTotal: number;
  /** Settled seasons the recoupment rows cover, oldest and newest. */
  recoupRange: [string, string] | null;
  routeRecoup: Array<RecoupRow<RouteBucketId>>;
  sourceRecoup: Array<RecoupRow<SourceBucketId>>;
  /** Every new production counted, newest first, for the list at the foot of the page. */
  showList: OriginListShow[];
  /** Revivals that arrived from London, by era (London transfers of revivals are a trend of their own). */
  revivalsFromLondon: { counts: number[]; totals: number[] };
}

export interface OriginListShow {
  slug: string;
  title: string;
  openingDate: string;
  type: string;
  route: RouteBucketId;
  source: SourceType;
  sourceTitle: string | null;
  pathNote: string | null;
  evidence: string | null;
  originalKind: OriginalKind | null;
}

export interface OriginShowInput extends RecoupShowInput {
  id: string;
  creativeTeam?: Array<{ name?: string | null }> | null;
  closingDate?: string | null;
}

/** Runs this short are one-off concerts and benefits, not productions. */
const MIN_RUN_DAYS = 3;

function isOneOff(s: { openingDate: string; closingDate?: string | null }): boolean {
  if (!s.closingDate) return false;
  return Date.parse(s.closingDate) - Date.parse(s.openingDate) <= MIN_RUN_DAYS * 86400000;
}

function emptyCell(): RateCell {
  return { recouped: 0, total: 0, recoupedShows: [] };
}

function eraIndex(openingDate: string): number {
  const season = getSeason(openingDate);
  if (!season) return -1;
  const start = parseInt(season.slice(0, 4), 10);
  return ERAS.findIndex((e) => start >= e.from && start <= e.to);
}

/** Recouped share, null below MIN_AVERAGE_SAMPLE shows. */
export function recoupRate(c: RateCell): number | null {
  return c.total >= MIN_AVERAGE_SAMPLE ? c.recouped / c.total : null;
}

/** Show id without its trailing opening year (waitress-2021 -> waitress). */
function idBase(id: string): string {
  return id.replace(/-\d{4}$/, '');
}

/** How far back an earlier run can be and still make a later one a return engagement. */
const RETURN_WINDOW_YEARS = 12;

interface ReturnInput {
  id: string;
  openingDate: string;
  isRevival?: boolean | null;
  creativeTeam?: Array<{ name?: string | null }> | null;
}

/**
 * Non-revival Broadway productions that follow an earlier Broadway production
 * of the same show: same id stem, within RETURN_WINDOW_YEARS, and at least one
 * shared creative-team name when both list one. Catches return engagements
 * (Waitress 2021, Beetlejuice 2022) and revivals flagged isRevival:false
 * (Hair 2011), but not a different show with the same title (Frozen 2018 vs
 * the 2004 play). They are not new productions, so the mix leaves them out.
 */
export function returnEngagementIds(shows: ReturnInput[]): Set<string> {
  const byBase = new Map<string, ReturnInput[]>();
  for (const s of shows) {
    const b = idBase(s.id);
    byBase.set(b, [...(byBase.get(b) ?? []), s]);
  }
  const names = (s: ReturnInput) => new Set((s.creativeTeam ?? []).map((c) => (c.name ?? '').trim().toLowerCase()).filter(Boolean));
  const out = new Set<string>();
  for (const s of shows) {
    if (s.isRevival === true) continue;
    const later = Date.parse(s.openingDate);
    const mine = names(s);
    const hit = (byBase.get(idBase(s.id)) ?? []).some((e) => {
      if (e === s || !(e.openingDate < s.openingDate)) return false;
      if (later - Date.parse(e.openingDate) > RETURN_WINDOW_YEARS * 365.25 * 86400000) return false;
      const theirs = names(e);
      return !mine.size || !theirs.size || [...mine].some((n) => theirs.has(n));
    });
    if (hit) out.add(s.id);
  }
  return out;
}

export function buildOriginFindings(
  shows: OriginShowInput[],
  origins: Record<string, OriginRecord>,
  asOf: string,
): OriginFindings {
  const settled = settledRecoupSeasons(shows, asOf);
  const settledSet = new Set(settled);
  const returns = returnEngagementIds(shows);

  const mixRows = <Id extends string>(buckets: ReadonlyArray<{ id: Id; label: string }>): Array<MixRow<Id>> =>
    buckets.map((b) => ({ id: b.id, label: b.label, counts: ERAS.map(() => 0), current: 0 }));
  const recoupRows = <Id extends string>(buckets: ReadonlyArray<{ id: Id; label: string }>): Array<RecoupRow<Id>> =>
    buckets.map((b) => ({ id: b.id, label: b.label, musicals: emptyCell(), plays: emptyCell(), all: emptyCell() }));

  const routeMix = mixRows(ROUTE_BUCKETS);
  const sourceMix = mixRows(SOURCE_BUCKETS);
  const musicalSourceMix = mixRows(SOURCE_BUCKETS);
  const routeRecoup = recoupRows(ROUTE_BUCKETS);
  const sourceRecoup = recoupRows(SOURCE_BUCKETS);
  const eraTotals = ERAS.map(() => 0);
  const musicalEraTotals = ERAS.map(() => 0);
  const currentSeason = getSeason(asOf);
  let currentTotal = 0;
  let musicalCurrentTotal = 0;
  const ever: Record<PathStage, number> = { 'off-broadway': 0, 'regional-us': 0, london: 0, international: 0 };
  const revivalsFromLondon = { counts: ERAS.map(() => 0), totals: ERAS.map(() => 0) };
  const showList: OriginListShow[] = [];
  let newProductions = 0;
  let musicals = 0;
  let plays = 0;

  for (const s of shows) {
    const o = origins[s.id];
    const era = eraIndex(s.openingDate);
    if (!o || era < 0 || typeof s.isRevival !== 'boolean') continue;
    if (isOneOff(s) || (!s.isRevival && returns.has(s.id))) continue;
    // Announced or in previews: not on Broadway yet. Counts only in the current-season
    // column (as the Season Report counts opened + announced), never in the era mixes,
    // the show list or recoupment.
    if (s.openingDate > asOf || s.status === 'previews' || s.status === 'upcoming') {
      // Specials are filed apart from productions in the Season Report, so they stay out here too.
      if (s.isRevival || (s.type !== 'musical' && s.type !== 'play')) continue;
      if (!currentSeason || getSeason(s.openingDate) !== currentSeason) continue;
      const isMusical = s.type === 'musical';
      const route = routeBucket(o.path);
      const src = sourceBucket(o.source, o.originalKind);
      currentTotal++;
      routeMix.find((r) => r.id === route)!.current++;
      sourceMix.find((r) => r.id === src)!.current++;
      if (isMusical) {
        musicalCurrentTotal++;
        musicalSourceMix.find((r) => r.id === src)!.current++;
      }
      continue;
    }
    if (s.isRevival) {
      revivalsFromLondon.totals[era]++;
      if (o.path.includes('london')) revivalsFromLondon.counts[era]++;
      continue;
    }
    const isMusical = s.type === 'musical';
    newProductions++;
    if (isMusical) musicals++;
    else plays++;
    eraTotals[era]++;
    const route = routeBucket(o.path);
    const src = sourceBucket(o.source, o.originalKind);
    routeMix.find((r) => r.id === route)!.counts[era]++;
    sourceMix.find((r) => r.id === src)!.counts[era]++;
    if (isMusical) {
      musicalEraTotals[era]++;
      musicalSourceMix.find((r) => r.id === src)!.counts[era]++;
    }
    if (currentSeason && getSeason(s.openingDate) === currentSeason) {
      currentTotal++;
      routeMix.find((r) => r.id === route)!.current++;
      sourceMix.find((r) => r.id === src)!.current++;
      if (isMusical) {
        musicalCurrentTotal++;
        musicalSourceMix.find((r) => r.id === src)!.current++;
      }
    }
    for (const stage of o.path) ever[stage]++;
    if (s.slug && s.title) {
      showList.push({
        slug: s.slug, title: s.title, openingDate: s.openingDate, type: s.type ?? '', route, source: o.source,
        sourceTitle: o.sourceTitle, pathNote: o.pathNote, evidence: o.evidence[0] ?? null,
        originalKind: o.originalKind ?? null,
      });
    }

    const season = getSeason(s.openingDate);
    const c = trackedRecord(s);
    if (!season || !settledSet.has(season) || !c || isExcludedFromSeasonStats(c)) continue;
    const recouped = c.recouped === true;
    for (const row of [routeRecoup.find((r) => r.id === route)!, sourceRecoup.find((r) => r.id === src)!]) {
      for (const cell of [row.all, isMusical ? row.musicals : row.plays]) {
        cell.total++;
        if (recouped) {
          cell.recouped++;
          if (s.slug && s.title) cell.recoupedShows.push({ slug: s.slug, title: s.title, year: s.openingDate.slice(0, 4) });
        }
      }
    }
  }

  for (const row of [...routeRecoup, ...sourceRecoup]) {
    for (const cell of [row.all, row.musicals, row.plays]) cell.recoupedShows.sort((a, b) => a.title.localeCompare(b.title));
  }

  return {
    newProductions,
    musicals,
    plays,
    eraTotals,
    routeMix,
    sourceMix,
    everPlayed: (Object.keys(ever) as PathStage[]).map((stage) => ({ stage, label: STAGE_LABELS[stage], count: ever[stage] })),
    musicalSourceMix,
    musicalEraTotals,
    currentSeason,
    currentTotal,
    musicalCurrentTotal,
    recoupRange: settled.length ? [settled[0], settled[settled.length - 1]] : null,
    routeRecoup,
    sourceRecoup,
    showList: showList.sort((a, b) => b.openingDate.localeCompare(a.openingDate)),
    revivalsFromLondon,
  };
}
