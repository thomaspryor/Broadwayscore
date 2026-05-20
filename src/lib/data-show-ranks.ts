/**
 * Show ranks across multiple metrics × pools, precomputed once at module load.
 *
 * Each show gets ranks for 5 metrics:
 *   - critic       (CriticScore — rounded for display-aligned ranking)
 *   - audience     (AudienceGrade — rounded combined score)
 *   - awards       (computeSiteAwardScore — Broadway only)
 *   - boxOffice    (thisWeek.gross raw $ — Broadway + West End only)
 *   - overall      (compositeScore — all markets)
 *
 * Three pools per metric:
 *   - openMarket: shows in the same market (broadway / west-end / off-broadway
 *                 / off-west-end) with status 'open' OR 'previews' (matches the
 *                 existing market-stats predicate at data-core.ts:128-131).
 *   - season:     same market, opened during the current award season.
 *                 BW/OB use getSeason() (Jul-Jun, matches /browse/{season}-broadway-season).
 *                 WE/OWE use the current Olivier eligibility window.
 *   - allTime:    same market, scored shows only (hasEnoughReviews true). 2005+.
 *
 * Two format slices: 'all' (no format filter) and per-show-type
 * ('musical' | 'play'). Special / Limited Engagement shows are 'all' only.
 *
 * Tie-break: competition rank on the rounded display value (1, 1, 3 — not
 * 1, 1, 2). Reason: with dense rank, "#34 of 619" reads as "top 5%" but
 * actually means "34th distinct score tier" — a 56-score (Skippable) show
 * can land at #34 when most pool entries cluster in the 70-95 range, which
 * is misleading. Competition rank keeps "#N of M" meaningful: N-1 shows
 * scored strictly higher than this one. Per memory/feedback_round_once_share_everywhere.md
 * the rounded display value is still what's compared.
 *
 * Null semantics:
 *   - Pool < 3 shows: returns null (rank in a pool of 2 isn't meaningful UX).
 *   - Target show not in its own pool (e.g. closed show on openMarket): null.
 *   - Show has no value for that metric: null.
 *
 * Performance:
 *   - Module-scope precomputed index. ensureBuilt() runs once on first call.
 *   - 5 metrics × 3 pools × 2 format slices = 30 sorted pools per build.
 *   - Each sort is O(n log n) on ~727 shows. Total build ~30 × 727 × 10 ops
 *     ≈ 220K ops, target <5s wall time on real data.
 *   - Per-page lookup is O(1) Map.get().
 *
 * Used by:
 *   - src/components/show-page/ShowHeroRedesign.tsx (hero rank line)
 *   - src/components/show-page/WhereItRanks.tsx (bottom rank card)
 *   - both consume via src/app/show/[slug]/page.tsx which calls getShowRanks().
 */

import type { ComputedShow } from '@/lib/data-types';
import { getAllShows } from '@/lib/data-core';
import { hasEnoughReviews } from '@/config/score-buckets';
import { getSeason } from '@/lib/data-commercial';
import { getAudienceBuzz, hasEnoughAudienceReviews } from '@/lib/data-audience';
import { computeSiteAwardScore, type Market } from '@/lib/awards-scoring';
import { getShowGrosses } from '@/lib/data-grosses';
import { isInCurrentOlivierSeason } from '@/lib/olivier-seasons';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RankMetric = 'critic' | 'audience' | 'awards' | 'boxOffice' | 'overall';
export type RankPool = 'openMarket' | 'season' | 'allTime';
export type RankFormat = 'all' | 'musical' | 'play';

export interface RankCell {
  rank: number;
  total: number;
}

export interface RankSet {
  openMarket: RankCell | null;
  season: RankCell | null;
  allTime: RankCell | null;
}

export interface ShowRanks {
  critic: RankSet;
  audience: RankSet;
  awards: RankSet;
  boxOffice: RankSet;
  overall: RankSet;
}

const EMPTY_RANK_SET: RankSet = { openMarket: null, season: null, allTime: null };
const EMPTY_SHOW_RANKS: ShowRanks = {
  critic: EMPTY_RANK_SET,
  audience: EMPTY_RANK_SET,
  awards: EMPTY_RANK_SET,
  boxOffice: EMPTY_RANK_SET,
  overall: EMPTY_RANK_SET,
};

// ─────────────────────────────────────────────────────────────────────────────
// Pool predicates
// ─────────────────────────────────────────────────────────────────────────────

type Category = ComputedShow['category'];

function sameMarket(show: ComputedShow, target: ComputedShow): boolean {
  return show.category === target.category;
}

function isInOpenPool(show: ComputedShow): boolean {
  return show.status === 'open' || show.status === 'previews';
}

function isInSeasonPool(show: ComputedShow, _market: Category): boolean {
  if (!show.openingDate) return false;
  // Broadway + Off-Broadway: use Jul-Jun "Broadway season" (matches /browse/{yyyy-yyyy}-broadway-season).
  // Off-Broadway has no official award eligibility window for v1 — re-use Tony-style season for consistency.
  // West End + Off-West End: use the current Olivier eligibility window.
  if (show.category === 'west-end' || show.category === 'off-west-end') {
    return isInCurrentOlivierSeason(show.openingDate);
  }
  const showSeason = getSeason(show.openingDate);
  const currentSeason = getSeason(new Date().toISOString().slice(0, 10));
  return showSeason !== null && showSeason === currentSeason;
}

function isInAllTimePool(show: ComputedShow): boolean {
  // "Scored shows only (2005+)" — `hasEnoughReviews` is the canonical gate
  // used by the score-display threshold, so this matches what users see.
  const reviewCount = show.criticScore?.reviewCount ?? 0;
  const tier1And2 = (show.criticScore?.tier1Count ?? 0) + (show.criticScore?.tier2Count ?? 0);
  return hasEnoughReviews(reviewCount, show.category, tier1And2, false);
}

function matchesFormat(show: ComputedShow, format: RankFormat): boolean {
  if (format === 'all') return true;
  return show.type === format;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-metric value extractors
// Round critic + audience scores so rank matches the user-visible value
// (per memory/feedback_round_once_share_everywhere.md).
// ─────────────────────────────────────────────────────────────────────────────

function valCritic(show: ComputedShow): number | null {
  const s = show.criticScore?.score;
  if (s == null) return null;
  // Rank only shows that pass the display threshold — sub-threshold shows show
  // TBD and shouldn't appear in the leaderboard.
  if (!isInAllTimePool(show)) return null;
  return Math.round(s);
}

/** Looser variant — any show with a critic score, no review-threshold gate.
 *  Used for the all-time pool so the denominator reflects every show we've
 *  scored (~750-800), not just modern shows passing the display threshold. */
function valCriticAllTime(show: ComputedShow): number | null {
  const s = show.criticScore?.score;
  if (s == null) return null;
  return Math.round(s);
}

function valAudience(show: ComputedShow): number | null {
  const buzz = getAudienceBuzz(show.id);
  if (!buzz || buzz.combinedScore == null) return null;
  if (!hasEnoughAudienceReviews(buzz)) return null;
  return Math.round(buzz.combinedScore);
}

function marketToAwardsKey(category: Category): Market | null {
  if (category === 'broadway') return 'broadway';
  if (category === 'off-broadway') return 'broadway'; // OB: Obie/Lortel/Drama Desk use broadway weights
  if (category === 'west-end') return 'west-end';
  // Off-West End: Olivier predictions not wired yet
  return null;
}

function valAwards(show: ComputedShow): number | null {
  const key = marketToAwardsKey(show.category);
  if (!key) return null;
  try {
    const result = computeSiteAwardScore(show.id, key);
    if (!result || typeof result.displayScore !== 'number') return null;
    // Treat 0 as "no awards data" — score is 0-100 and a real award would lift it.
    if (result.displayScore === 0) return null;
    return result.displayScore;
  } catch {
    return null;
  }
}

function valBoxOfficeThisWeek(show: ComputedShow): number | null {
  // Weekly gross — currently-running shows only. Used for the openMarket pool.
  if (show.category !== 'broadway' && show.category !== 'west-end') return null;
  const g = getShowGrosses(show.slug);
  const gross = g?.thisWeek?.gross;
  if (gross == null) return null;
  return gross;
}

function valBoxOfficeAllTime(show: ComputedShow): number | null {
  // Cumulative all-time gross — every show that has ever reported grosses.
  // Used for the all-time pool so a Skippable-but-historic show can rank
  // against Phantom / Wicked / Lion King by lifetime revenue.
  if (show.category !== 'broadway' && show.category !== 'west-end') return null;
  const g = getShowGrosses(show.slug);
  const gross = g?.allTime?.gross;
  if (gross == null) return null;
  return gross;
}

function valOverall(show: ComputedShow): number | null {
  const s = show.compositeScore;
  if (s == null) return null;
  // Same display-threshold gate as critic.
  if (!isInAllTimePool(show)) return null;
  return s;
}

/** Looser variant — every show with a compositeScore. All-time pool. */
function valOverallAllTime(show: ComputedShow): number | null {
  const s = show.compositeScore;
  if (s == null) return null;
  return s;
}

/**
 * Resolves the value for a (metric, pool) combo. Most metrics use the same
 * extractor regardless of pool — boxOffice is the exception: weekly gross
 * for openMarket, cumulative for allTime, N/A for season (no season-to-date
 * cumulative is tracked).
 */
function getMetricValue(show: ComputedShow, metric: RankMetric, pool: RankPool): number | null {
  if (metric === 'boxOffice') {
    if (pool === 'openMarket') return valBoxOfficeThisWeek(show);
    if (pool === 'allTime') return valBoxOfficeAllTime(show);
    return null; // season — no season-to-date cumulative available
  }
  // All-time pool uses the fullest data we have for each metric — no
  // review-threshold or season gate. Audience already self-filters via
  // hasEnoughAudienceReviews; awards self-filters via score>0; box-office
  // via allTime.gross presence.
  if (pool === 'allTime') {
    if (metric === 'critic') return valCriticAllTime(show);
    if (metric === 'audience') return valAudience(show);
    if (metric === 'awards') return valAwards(show);
    if (metric === 'overall') return valOverallAllTime(show);
  }
  if (metric === 'critic') return valCritic(show);
  if (metric === 'audience') return valAudience(show);
  if (metric === 'awards') return valAwards(show);
  if (metric === 'overall') return valOverall(show);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-scope precomputed index
// ─────────────────────────────────────────────────────────────────────────────

interface BuildKey {
  market: Category;
  metric: RankMetric;
  pool: RankPool;
  format: RankFormat;
}

function buildKey(k: BuildKey): string {
  return `${k.market}|${k.metric}|${k.pool}|${k.format}`;
}

interface PoolResult {
  /** showId → {rank, total}. Missing show = not in pool. */
  ranks: Map<string, RankCell>;
  total: number;
}

let INDEX: Map<string, PoolResult> | null = null;
let RANKS_BY_SHOW: Map<string, { all: ShowRanks; musical: ShowRanks | null; play: ShowRanks | null }> | null = null;

const MIN_POOL_SIZE = 3;

const METRICS: RankMetric[] = ['critic', 'audience', 'awards', 'boxOffice', 'overall'];
const POOLS: RankPool[] = ['openMarket', 'season', 'allTime'];
const FORMATS: RankFormat[] = ['all', 'musical', 'play'];
const MARKETS: Category[] = ['broadway', 'west-end', 'off-broadway', 'off-west-end'];

function poolPredicate(pool: RankPool): (show: ComputedShow) => boolean {
  if (pool === 'openMarket') return isInOpenPool;
  if (pool === 'season') return (s) => isInSeasonPool(s, s.category);
  // All-time: include every show in the catalogue. Per-metric filtering is
  // done by the metric extractor (a show only enters a metric's all-time
  // pool if its extractor returns a value), so the pool size is the FULLEST
  // we have for each metric — e.g. ~750 critic-scored shows, ~1340 with
  // all-time gross, ~250 with audience grade.
  return () => true;
}

function computePool(
  allShows: ComputedShow[],
  market: Category,
  metric: RankMetric,
  pool: RankPool,
  format: RankFormat,
): PoolResult {
  const predicate = poolPredicate(pool);

  // Filter pool: same market + pool predicate + format + has metric value.
  // Value resolver is per-(metric, pool) so box-office can return weekly
  // gross for openMarket and cumulative gross for all-time.
  const entries: { id: string; v: number }[] = [];
  for (const s of allShows) {
    if (s.category !== market) continue;
    if (!matchesFormat(s, format)) continue;
    if (!predicate(s)) continue;
    const v = getMetricValue(s, metric, pool);
    if (v == null) continue;
    entries.push({ id: s.id, v });
  }

  const ranks = new Map<string, RankCell>();
  if (entries.length < MIN_POOL_SIZE) {
    return { ranks, total: entries.length };
  }

  // Sort desc by value; assign competition rank ("1, 1, 3, 4") so #N of M
  // means "N-1 shows scored strictly higher than this one".
  entries.sort((a, b) => b.v - a.v);
  let lastVal: number | null = null;
  let lastRank = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.v !== lastVal) {
      lastRank = i + 1;
      lastVal = e.v;
    }
    ranks.set(e.id, { rank: lastRank, total: entries.length });
  }

  return { ranks, total: entries.length };
}

function ensureBuilt(allShowsOverride?: ComputedShow[]): void {
  if (INDEX && RANKS_BY_SHOW) return;

  const allShows = allShowsOverride ?? getAllShows();
  INDEX = new Map();
  RANKS_BY_SHOW = new Map();

  for (const market of MARKETS) {
    for (const metric of METRICS) {
      for (const pool of POOLS) {
        for (const format of FORMATS) {
          const key = buildKey({ market, metric, pool, format });
          INDEX.set(key, computePool(allShows, market, metric, pool, format));
        }
      }
    }
  }

  // Now flip the index inside-out: per show, build ShowRanks for each
  // applicable format slice. Storing the same RankCell object reference is
  // fine — RankCell is immutable by convention.
  for (const show of allShows) {
    const all = assembleShowRanks(show, 'all');
    const ownFormat: RankFormat | null = show.type === 'musical' || show.type === 'play' ? show.type : null;
    const formatSpecific = ownFormat ? assembleShowRanks(show, ownFormat) : null;
    RANKS_BY_SHOW.set(show.id, {
      all,
      musical: ownFormat === 'musical' ? formatSpecific : null,
      play: ownFormat === 'play' ? formatSpecific : null,
    });
  }
}

function assembleShowRanks(show: ComputedShow, format: RankFormat): ShowRanks {
  if (!INDEX) return EMPTY_SHOW_RANKS;
  const market = show.category as Category;
  const out: ShowRanks = {
    critic: { ...EMPTY_RANK_SET },
    audience: { ...EMPTY_RANK_SET },
    awards: { ...EMPTY_RANK_SET },
    boxOffice: { ...EMPTY_RANK_SET },
    overall: { ...EMPTY_RANK_SET },
  };
  for (const metric of METRICS) {
    for (const pool of POOLS) {
      const key = buildKey({ market, metric, pool, format });
      const result = INDEX.get(key);
      if (!result) continue;
      const cell = result.ranks.get(show.id);
      if (!cell) continue;
      out[metric][pool] = cell;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface GetShowRanksOpts {
  /**
   * 'all' — ranks across All shows in the market (every show counted).
   * 'musical' / 'play' — narrowed to the show's own format. Returns null for
   * shows that aren't a musical or play (Special, Limited Engagement, etc.).
   */
  format?: RankFormat;
}

/**
 * Returns precomputed ranks for the given show across all metrics × pools.
 * O(1) lookup after first call (index is built lazily on first invocation).
 *
 * Returns null if the show ID is unknown OR if the requested format slice
 * doesn't apply (e.g. format='play' on a musical).
 */
export function getShowRanks(showId: string, opts: GetShowRanksOpts = {}): ShowRanks | null {
  ensureBuilt();
  if (!RANKS_BY_SHOW) return null;
  const entry = RANKS_BY_SHOW.get(showId);
  if (!entry) return null;
  const format = opts.format ?? 'all';
  if (format === 'all') return entry.all;
  if (format === 'musical') return entry.musical;
  return entry.play;
}

/**
 * Test-only: re-build the index against a specific show set. Useful for unit
 * tests that pass synthetic fixtures rather than loading the real catalogue.
 *
 * Resets the cached index and rebuilds from `allShows`. NOT intended for
 * production callers — production callers should rely on getAllShows().
 */
export function __rebuildIndexForTests(allShows: ComputedShow[]): void {
  INDEX = null;
  RANKS_BY_SHOW = null;
  ensureBuilt(allShows);
}

/**
 * Returns module-internal pool totals for a single (market, metric, pool, format).
 * Test/debug helper — production code should use getShowRanks().
 */
export function __getPoolTotalForTests(
  market: Category,
  metric: RankMetric,
  pool: RankPool,
  format: RankFormat,
): number {
  ensureBuilt();
  return INDEX?.get(buildKey({ market, metric, pool, format }))?.total ?? 0;
}
