/**
 * Shared data logic for Tony Awards predictions and hub pages.
 * Extracted from src/app/tony-awards/page.tsx to avoid duplication.
 */

import { getBroadwayShows } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/engine';
import { getAudienceBuzz, getAudienceGrade, hasEnoughAudienceReviews } from '@/lib/data-audience';
import { isTonyEligible } from '@/lib/data-awards';
import {
  tonySeasonForCeremonyYear,
  currentPredictionSeason,
  FIRST_TRACKED_CEREMONY_YEAR,
} from '@/lib/tony-cutoffs';
// classifyCategory maps precursor category names → tier (S/A+/A/B/C). Shared
// with awards-scoring.ts (Site Award Score uses different prestige weights;
// we use predictive weights below).
import { classifyCategory, computeSiteAwardScore, type CategoryTier } from '@/lib/awards-scoring';

// Import commercial.json directly to avoid pulling in grosses-history.json
import fs from 'fs';
import path from 'path';
import commercialData from '../../data/commercial.json';
import awardsData from '../../data/awards.json';
import gdRawData from '../../data/tony-win-probabilities.json';
import criticPicksRawData from '../../data/tony-critic-picks.json';

type MarketData = { categories: Record<string, { nominees: Record<string, number> }> };

function loadMarketJson(filename: string): MarketData | null {
  try {
    const p = path.join(process.cwd(), 'data', filename);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as MarketData;
  } catch { return null; }
}

const pmRawData = loadMarketJson('tony-polymarket-odds.json');
const kaRawData = loadMarketJson('tony-kalshi-odds.json');

function lookupMarketOdds(title: string, catTitle: string, data: MarketData | null): number | null {
  if (!data) return null;
  const nominees = data.categories?.[catTitle]?.nominees;
  if (!nominees) return null;
  if (title in nominees) return nominees[title];
  const lower = title.toLowerCase();
  for (const [k, v] of Object.entries(nominees)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

// GoldDerby category names → canonical Tony category titles
const TONY_TO_GD: Record<string, string> = {
  'Best Musical':           'Best Musical',
  'Best Play':              'Best Play',
  'Best Revival of a Musical': 'Best Musical Revival',
  'Best Revival of a Play':    'Best Play Revival',
};

type GdShowEntry = { categories: Record<string, { pWin: number; votes: number }> };
type GdData = { shows: Record<string, GdShowEntry> };

function lookupGdOdds(showId: string, tonyCategory: string): number | null {
  const gdCatName = TONY_TO_GD[tonyCategory];
  if (!gdCatName) return null;
  const gd = gdRawData as unknown as GdData;
  const show = gd.shows?.[showId];
  if (!show) return null;
  const cat = show.categories?.[gdCatName];
  if (!cat || cat.votes === 0) return null;
  return typeof cat.pWin === 'number' ? cat.pWin : null;
}

// Acting categories match by person name; all others match by showId.
const PERSON_MATCH_CATEGORIES = new Set([
  'Best Actor in a Musical', 'Best Actress in a Musical',
  'Best Actor in a Play', 'Best Actress in a Play',
  'Best Featured Actor in a Musical', 'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play', 'Best Featured Actress in a Play',
]);

type CriticPicksData = {
  sources: Array<{ id: string; outlet: string; critic: string; shortName: string; color: string; url: string }>;
  picks: Record<string, Record<string, string>>;
};

/** Return outlet IDs whose critic predicted this show/person for the given category. */
export function lookupCriticPicks(showId: string, personName: string | null, tonyCategory: string): string[] {
  const data = criticPicksRawData as unknown as CriticPicksData;
  const catPicks = data.picks[tonyCategory];
  if (!catPicks) return [];
  const isPersonCategory = PERSON_MATCH_CATEGORIES.has(tonyCategory);
  const result: string[] = [];
  for (const [outletId, pick] of Object.entries(catPicks)) {
    if (isPersonCategory) {
      if (personName && pick.toLowerCase() === personName.toLowerCase()) result.push(outletId);
    } else {
      if (pick === showId) result.push(outletId);
    }
  }
  return result;
}

/** Metadata for critic pick outlet badges, keyed by outlet ID. */
export type CriticPickSource = { outlet: string; critic: string; shortName: string; color: string; url: string };
export function getCriticPickSources(): Record<string, CriticPickSource> {
  const data = criticPicksRawData as unknown as CriticPicksData;
  return Object.fromEntries(data.sources.map(s => [s.id, s]));
}

/**
 * Legacy: per-category Tony recipes replaced the flat 50/50 blend on 2026-04-29.
 * Kept exported for back-compat in case any external script imports it.
 */
export const TONY_BLEND_WEIGHT = 0.5;

/**
 * Per-category blending recipes. Tuned against 11 Tony seasons (2013-14 →
 * 2024-25, 42 contests).
 *
 * Audit script (scripts/audit-tony-all-seasons.ts) reports in-sample top-1
 * accuracy: 41/43 (95.3%) including the COVID-truncated season, vs. 32/43
 * (74.4%) baseline using critic-only. The leave-one-season-out (LOSO)
 * accuracy of the design process that produced these recipe weights was
 * 92.9% per the offline backtest; that figure isn't reproducible from this
 * repo alone (the recipes are constants, not fit per-fold), so user-facing
 * copy claims the in-sample number which IS reproducible from CI.
 *
 * Tier 1 / Live recipe — works year-round. Pre-precursor, Best Play's
 * awards term renormalizes out of tonyComposite, so the formula reduces to
 * a true 50/50 critic+audience until precursor noms drop in early May.
 */
// best-musical weights nudged from 0.40/0.60/0.00 to 0.45/0.55/0.00 on
// 2026-05-16 (Notion 362637c5-416f-81bc-8a36-e354ec4051f1). The 11-season
// backtest at step 0.05 picked 0.45/0.55/0.00 as the unique 11/11 in-sample
// winner; leave-one-out CV confirms 10 of 11 folds independently selected
// the same weights. Net effect: +1 correct season (was 10/11, now 11/11)
// while staying inside the LOOCV-optimal plateau (no overfit). See
// scripts/search-tony-best-play-weights.ts --cat=best-musical.
//
// best-play changed from 0.40/0.40/0.20 to 0.65/0.00/0.35 on 2026-05-17.
// Grid search at step 0.05 found critic+awards recipes dominate (11/11
// in-sample, 90.9% LOOCV). {0.65/0/0.35} is the mode across 10/11 LOOCV
// folds. Audience weight dropped to 0: audience is less predictive for plays
// where Tony voters (theater professionals) follow critical consensus and
// precursor awards over crowd reaction. Net: 10/11 (90.9%) in-sample →
// 11/11 (100%). Also produces steeper score descent (Liberation leads by
// 17pt vs 10pt), matching market confidence levels. See
// scripts/search-tony-best-play-weights.ts --cat=best-play.
//
// best-revival-play changed from 0.00/0.95/0.05 to 0.40/0.60/0.00 on
// 2026-05-17. All 3 historical misses had awards signal anti-correlated with
// winning — dropping awards to 0 and adding critic (0.40) gets 9/10
// in-sample (90.0%) vs 7/10 (70.0%) for the old 0.0/0.8/0.2 recipe.
// LOOCV: 8/10 (80.0%). Current-season DoA still #1 by 2+ pts. See
// scripts/search-tony-best-play-weights.ts --cat=best-revival-play.
export const TONY_RECIPES: Record<string, { critic: number; audience: number; awards: number }> = {
  'best-musical':         { critic: 0.43, audience: 0.52, awards: 0.05 },
  'best-play':            { critic: 0.65, audience: 0.00, awards: 0.35 },
  'best-revival-musical': { critic: 0,    audience: 1.0,  awards: 0    },
  'best-revival-play':    { critic: 0.4,  audience: 0.6,  awards: 0    },
};

/**
 * Tier 2 / Final recipe — flips for Best Play after all three precursor
 * winners (Drama Desk, Outer Critics Circle, Drama League) are announced.
 * 11-season backtest accuracy: Tier 1 91% → Tier 2 95% for Best Play
 * (source: ~/Documents/claude-outputs/tony-phase3-2026-04-28.md).
 *
 * Only Best Play differs — the other 3 categories' Tier 1 weights are
 * already empirically optimal per the same backtest.
 *
 * Selection logic (see resolveRecipeTier):
 *   - Active season → automatic flip once shouldUseTier2(season) returns
 *     true (3 of 3 precursor winners present for Best Play category).
 *   - Past seasons → always Tier 2 (winners have long since been announced).
 *   - Manual override: env TONY_RECIPE_TIER=1|2 forces either tier (used by
 *     scripts/audit-tony-all-seasons.ts --tier=N flag for backtesting).
 */
export const TONY_RECIPES_TIER2: Record<string, { critic: number; audience: number; awards: number }> = {
  'best-musical':         { critic: 0.4, audience: 0.55, awards: 0.05 },
  'best-play':            { critic: 0.2, audience: 0.2,  awards: 0.6  },
  'best-revival-musical': { critic: 0,   audience: 1.0,  awards: 0    },
  'best-revival-play':    { critic: 0,   audience: 0.7,  awards: 0.3  },
};

export type TonyCategoryKey = keyof typeof TONY_RECIPES;
export type RecipeTier = 1 | 2;

/** Return the recipe map for the requested tier (1 default). */
export function getRecipe(categoryKey: TonyCategoryKey, tier: RecipeTier = 1) {
  return tier === 2 ? TONY_RECIPES_TIER2[categoryKey] : TONY_RECIPES[categoryKey];
}

/** Tony top category → matching nominee categories at each precursor. Each
 *  entry is an ARRAY because some precursors (notably OCC, sometimes DL)
 *  split their top category into Broadway / Off-Broadway buckets. Shows that
 *  transferred OB → Broadway (Hamilton 2015, Fun Home 2014, etc.) have their
 *  precursor wins recorded under the OB category name. Without aliasing,
 *  the Broadway top-cat bonus misses them — Hamilton scored 75 instead of
 *  the ~100 expected for a near-sweeper. See Notion 362637c5-...dcf0b0.
 *
 *  DD uses unified "Outstanding Musical" / "Outstanding Play" across venues
 *  (single string suffices). DL sometimes records "Outstanding Production of
 *  a Broadway or Off-Broadway Musical/Play" as a combined bucket — both
 *  variants count toward the Broadway top-cat. */
const TONY_TO_PRECURSOR_CATEGORY: Record<string, { dramadesk: string[]; outerCriticsCircle: string[]; dramaLeague: string[] }> = {
  'Best Musical': {
    dramadesk: ['Outstanding Musical'],
    outerCriticsCircle: ['Outstanding New Broadway Musical', 'Outstanding New Off-Broadway Musical'],
    dramaLeague: ['Outstanding Production of a Musical', 'Outstanding Production of a Broadway or Off-Broadway Musical'],
  },
  'Best Play': {
    dramadesk: ['Outstanding Play'],
    outerCriticsCircle: ['Outstanding New Broadway Play', 'Outstanding New Off-Broadway Play'],
    dramaLeague: ['Outstanding Production of a Play', 'Outstanding Production of a Broadway or Off-Broadway Play'],
  },
  'Best Revival of a Musical': {
    dramadesk: ['Outstanding Revival of a Musical'],
    outerCriticsCircle: ['Outstanding Revival of a Musical'],
    dramaLeague: ['Outstanding Revival of a Musical'],
  },
  'Best Revival of a Play': {
    dramadesk: ['Outstanding Revival of a Play'],
    outerCriticsCircle: ['Outstanding Revival of a Play'],
    dramaLeague: ['Outstanding Revival of a Play'],
  },
};

/** Precursor predictive weight (DL strongest, DD weakest historically). */
const PRECURSOR_TIER_WEIGHTS = {
  dramaLeague: 1.0,
  outerCriticsCircle: 0.9,
  dramadesk: 0.7,
} as const;

/**
 * Per-category ceiling for the totalNoms tail term. The old formula used a
 * flat min(25, totalNoms) which biased musicals (eligible for ~12 craft
 * categories at each precursor) over plays (~6) — a play with 5 noms looked
 * the same as a musical with 5 noms despite the play being closer to a
 * sweep. We now normalize: nomScore = 25 * min(1, totalNoms / categoryPool).
 *
 * Ceilings derived empirically from the 11-season backtest (max observed:
 * musicals 24, plays 19, revival-musicals 12, revival-plays 3) with ~25-50%
 * headroom for outlier sweeps. Intra-category rankings unchanged (constant
 * rescale); cross-category visual comparison becomes fair.
 */
// Ceilings re-derived 2026-05-16 post-/ship-check against the weighted-noms
// scale (which is much smaller than the old `nominations` integer scale).
// 95th-percentile observed weighted-noms per category: musical 14.5, play 3.0,
// revival-musical 2.5, revival-play 1.5. Ceilings give modest headroom for
// future precursor backfill expansion without making the noms tail saturate
// immediately. Run scripts/derive-noms-pool-ceilings.js after backfill to
// re-check.
const NOMS_POOL_BY_CATEGORY: Record<string, number> = {
  'best-musical':         15,
  'best-play':             6,
  'best-revival-musical':  6,
  'best-revival-play':     3,
};
const NOMS_TAIL_CAP = 25;

/**
 * Predictive weights per category tier (NOT the prestige weights in
 * awards-scoring.ts — same tier system, different point allocation tuned
 * for forecasting Tony winners). Tier S (matching top cat) is already
 * counted via the +30 win / +10 nom bonus, so weight 0 here. Higher tiers
 * (A+ = score/book, A = director/lead acting) carry more predictive signal
 * than craft (C = design). Applied to the totalNoms tail term.
 */
const PRECURSOR_TIER_NOM_WEIGHTS: Record<CategoryTier, number> = {
  S:    0,    // already counted via +30/+10
  'A+': 2.0,
  A:    1.5,
  B:    1.0,
  C:    0.5,
};

/**
 * Points awarded per Tony nomination (NOT wins — wins come at the ceremony
 * and are what we're trying to predict). Used in computeAwardsScore to add
 * Tony nomination breadth as a pre-ceremony signal. The top category being
 * predicted is excluded (all nominees have it). Higher-tier categories
 * (direction, leading acting) carry more voter-support signal than design.
 */
const TONY_NOM_WEIGHTS: Record<CategoryTier, number> = {
  S:    0,    // excluded (top category being predicted)
  'A+': 5,
  A:    4,
  B:    3,
  C:    2,
};

const CATEGORY_KEY_TO_TITLE: Record<TonyCategoryKey, string> = {
  'best-musical': 'Best Musical',
  'best-play': 'Best Play',
  'best-revival-musical': 'Best Revival of a Musical',
  'best-revival-play': 'Best Revival of a Play',
};

// --- Shared Types ---

export interface SerializedTonyShow {
  slug: string;
  title: string;
  venue: string;
  openingDate: string;
  previewsStartDate?: string;
  status: string;
  compositeScore: number | null;
  reviewCount: number;
  thumbnailPath: string | null;
  audienceCombinedScore: number | null;
  audienceGrade: { grade: string; label: string; color: string; textColor: string; tooltip: string } | null;
  /** Per-category Tony composite (replaces the legacy 50/50 blend). */
  blendedScore: number | null;
  /** Mean of Show Score + Mezzanine — the audience input the predictor uses. */
  tonyAudienceGrade: number | null;
  /** 0-100 internal predictive signal from precursor wins/noms (used in blended model only). */
  awardsScore: number;
  /** Site Award Score displayed to users — same as the show page badge (computeSiteAwardScore). */
  siteAwardsScore: number;
  /** Which Tony category this show was serialized in (drives the recipe). */
  tonyCategoryKey: TonyCategoryKey | null;
  /** Win probability 0–1 from GoldDerby crowd votes. */
  gdOdds?: number | null;
  /** Cast page slug for linking to /cast/[slug] (person-level nominees only). */
  nomineeActorSlug?: string | null;
  /** Tony nominations won before the current season. */
  nomineePriorNominations?: number;
  /** Tony wins before the current season. */
  nomineePriorWins?: number;
  /** Win probability 0–1 from Polymarket real-money market. Null if no market exists. */
  polymarketOdds?: number | null;
  /** Win probability 0–1 from Kalshi real-money market. Null if no market exists. */
  kalshiOdds?: number | null;
  /** Person name for acting/directing nominations (e.g. "Sarah Snook"); null for show-level categories. */
  nomineePersonName?: string | null;
  /** Tony category title for non-major categories (e.g. "Best Costume Design of a Musical"). */
  nomineeCategoryTitle?: string | null;
  /** Outlet IDs (e.g. "nyt", "variety") whose critic picked this show/person to win. */
  criticPicks?: string[];
  /** Ceremonies where this show won the matching Tony category: 'DL', 'OCC', 'DD'. */
  precursorWins?: string[];
}

// --- Tony Season Logic ---

export interface TonySeasonWindow {
  start: string;
  end: string;
  label: string;
  ceremonyYear: number;
}

export function getTonySeasonWindow(): TonySeasonWindow {
  // Uses currentPredictionSeason() (not currentTonySeason()) so the predictions
  // page stays on the outgoing season during the April→June gap — after the
  // eligibility cutoff but before the ceremony. E.g. Apr 27–Jun 6, 2026:
  // currentTonySeason() → 2026-27 (empty); currentPredictionSeason() → 2025-26
  // (16 nominees, ceremony Jun 7). See tony-cutoffs.ts for the gap logic.
  const record = currentPredictionSeason();
  return recordToWindow(record);
}

function recordToWindow(record: { ceremonyYear: number; label: string; start: string; end: string }): TonySeasonWindow {
  // The TonySeasonWindow.label uses the long form "2025-2026" expected by
  // existing callers (sitemap, page generation). tony-cutoffs uses the short
  // form "2025-26" that matches awards.json season fields. Translate here.
  const [yearA] = record.label.split('-');
  return {
    start: record.start,
    end: record.end,
    label: `${yearA}-${record.ceremonyYear}`,
    ceremonyYear: record.ceremonyYear,
  };
}

// --- Data Preparation ---

export interface TonyCategory {
  key: string;
  title: string;
  description: string;
  shows: SerializedTonyShow[];
  upcoming: SerializedTonyShow[];
}

/**
 * Shows that opened in the Tony season window but were ruled ineligible for
 * competitive categories by the Tony Administration Committee (or marked
 * eligible:false in awards.json for other reasons — e.g., not-yet-opened at
 * time of entry). Rendered in a small footer under each prediction category
 * to explain to visitors why a show they expected to see is missing.
 */
export interface IneligibleShow {
  slug: string;
  title: string;
  categoryKey: TonyCategoryKey;
  note: string;
}

/**
 * Compute the audience input for the Tony predictor.
 * Defined as mean(Show Score, Mezzanine) — narrower than the site-wide audience
 * grade (which blends 5 sources by reviewCount). These two have the most
 * consistent coverage across the 11-season backtest window.
 */
export function computeTonyAudienceGrade(showId: string): number | null {
  const buzz = getAudienceBuzz(showId);
  if (!buzz) return null;
  const ss = buzz.sources?.showScore?.score;
  const mz = buzz.sources?.mezzanine?.score;
  const vals: number[] = [];
  if (typeof ss === 'number' && ss >= 0 && ss <= 100) vals.push(ss);
  if (typeof mz === 'number' && mz >= 0 && mz <= 100) vals.push(mz);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

type PrecursorNode = { wins?: string[]; nominatedFor?: string[]; nominations?: number };

/**
 * Compute a 0-100 Awards Score for a show in a given Tony category, based on
 * precursor signal (Drama League 1.0, OCC 0.9, Drama Desk 0.7):
 *   +30*tier if won the matching category at that precursor
 *   +10*tier if nominated (but didn't win) the matching category
 *   + min(25, 25 * weightedNoms / categoryPool)
 *
 * weightedNoms sums each NON-matching-top-cat nom × its tier weight via
 * classifyCategory (shared with awards-scoring.ts). A nom for Director
 * (tier A, weight 1.5) counts more than a nom for Lighting Design (tier C,
 * weight 0.5). Categories that don't match any tier rule are ignored.
 *
 * Pre-tier-weighting (2026-05-16) we used a flat per-nom count via the
 * `nominations` integer fallback. Under current data shape (precursor
 * nominatedFor arrays often contain only the matching top cat), weightedNoms
 * is typically 0 for non-winners — until per-category backfill (Sprint 2)
 * populates DD/OCC/DL nominatedFor with director/acting/etc. Safe
 * degradation: scores stay correct for shows with rich Tony nominatedFor
 * but drop noms-tail credit for shows that previously got it from the
 * `nominations` integer.
 *
 * Returns 0 pre-precursor (which makes Best Play degenerate to 50/50).
 */
/** Returns abbreviated ceremony names where this show won the matching Tony category. */
export function getPrecursorWins(showId: string, tonyCategory: string): string[] {
  const shows = (awardsData as Record<string, unknown>).shows as Record<string, {
    dramadesk?: { wins?: string[] };
    outerCriticsCircle?: { wins?: string[] };
    dramaLeague?: { wins?: string[] };
    pulitzer?: { wins?: string[] };
    nyDramaCritics?: { wins?: string[] };
  }>;
  const entry = shows[showId];
  if (!entry) return [];
  const matching = TONY_TO_PRECURSOR_CATEGORY[tonyCategory];
  if (!matching) return [];
  const result: string[] = [];
  if (matching.dramaLeague.some(c => (entry.dramaLeague?.wins ?? []).includes(c))) result.push('DL');
  if (matching.outerCriticsCircle.some(c => (entry.outerCriticsCircle?.wins ?? []).includes(c))) result.push('OCC');
  if (matching.dramadesk.some(c => (entry.dramadesk?.wins ?? []).includes(c))) result.push('DD');
  // Pulitzer Prize for Drama (relevant for plays and musicals, including revivals)
  if ((entry.pulitzer?.wins ?? []).includes('Drama')) result.push('PULITZER');
  // NY Drama Critics Circle (Best Play and Best Musical categories only)
  const nydccCat =
    tonyCategory === 'Best Play' || tonyCategory === 'Best Revival of a Play' ? 'Best Play' :
    tonyCategory === 'Best Musical' || tonyCategory === 'Best Revival of a Musical' ? 'Best Musical' :
    null;
  if (nydccCat && (entry.nyDramaCritics?.wins ?? []).includes(nydccCat)) result.push('NYDCC');
  return result;
}

export function computeAwardsScore(showId: string, tonyCategory: string): number {
  const shows = (awardsData as Record<string, unknown>).shows as Record<string, AwardsShowEntry & {
    dramadesk?: PrecursorNode;
    outerCriticsCircle?: PrecursorNode;
    dramaLeague?: PrecursorNode;
  }>;
  const entry = shows[showId];
  if (!entry) return 0;

  const matching = TONY_TO_PRECURSOR_CATEGORY[tonyCategory];
  if (!matching) return 0;
  const categoryKey = tonyCategoryKeyForTitle(tonyCategory);
  // Default pool to the new-musical ceiling if the category is unknown — keeps
  // historical-winners scroller (which can pass arbitrary Tony titles) safe.
  const pool = categoryKey ? NOMS_POOL_BY_CATEGORY[categoryKey] : NOMS_POOL_BY_CATEGORY['best-musical'];

  const sources = [
    { node: entry.dramaLeague,        matchCats: matching.dramaLeague,        tier: PRECURSOR_TIER_WEIGHTS.dramaLeague },
    { node: entry.outerCriticsCircle, matchCats: matching.outerCriticsCircle, tier: PRECURSOR_TIER_WEIGHTS.outerCriticsCircle },
    { node: entry.dramadesk,          matchCats: matching.dramadesk,          tier: PRECURSOR_TIER_WEIGHTS.dramadesk },
  ];

  let base = 0;
  let weightedNoms = 0;

  for (const { node, matchCats, tier } of sources) {
    if (!node) continue;
    const wins = node.wins || [];
    const noms = node.nominatedFor || [];

    // Match if ANY of the matchCats variants is recorded as a win/nom.
    // matchCats is an array to support OB → Broadway transfer aliasing
    // (Hamilton, Fun Home etc. — see TONY_TO_PRECURSOR_CATEGORY comment).
    if (matchCats.some((c) => wins.includes(c))) {
      base += 30 * tier;
    } else if (matchCats.some((c) => noms.includes(c))) {
      base += 10 * tier;
    }

    // Tier-weighted noms tail. Skip the matching top cat (already counted
    // via the +30/+10 bonus above). Iterate the UNION of wins + nominatedFor
    // because the two precursor data conventions differ:
    //   - Tony: wins ⊂ nominatedFor (wins are always also in noms; iterating
    //     noms is sufficient).
    //   - DD/OCC/DL: wins and nominatedFor are largely DISJOINT (nominatedFor
    //     typically holds only the matching top cat; non-top-cat wins live
    //     in wins[] only). Iterating only noms would silently miss most
    //     precursor wins and dramatically under-credit sweepers like Hamilton.
    // classifyCategory returns null for unrecognized strings — ignored.
    const matchCatSet = new Set(matchCats);
    const seenCategories = new Set<string>();
    const allCategories = [...wins, ...noms];
    for (const nomCat of allCategories) {
      if (matchCatSet.has(nomCat)) continue;
      if (seenCategories.has(nomCat)) continue;
      seenCategories.add(nomCat);
      const cls = classifyCategory(nomCat);
      if (!cls) continue;
      weightedNoms += PRECURSOR_TIER_NOM_WEIGHTS[cls.tier];
    }
  }

  // Eligible-pool-normalized noms term. Categories with bigger eligible
  // pools (musicals) cap at the same value as smaller pools (plays), so
  // cross-category awards numbers are visually fair.
  const nomsScore = NOMS_TAIL_CAP * Math.min(1, weightedNoms / pool);
  base += nomsScore;

  // Tony nomination breadth bonus (post-nomination-announcement only).
  // Tony nominations are pre-ceremony signals — they indicate broad voter
  // support across categories. Tony WINS are excluded (that's what we
  // predict). The top category being predicted is also excluded since all
  // nominees share it. Using nominatedFor (which includes all noms, won or
  // not) is correct: wins-vs-noms distinction only matters for the ceremony
  // outcome we're predicting, not for counting voter interest pre-ceremony.
  const tonyNoms = (entry.tony?.nominatedFor ?? []).filter(n => n !== tonyCategory);
  for (const nomCat of tonyNoms) {
    const cls = classifyCategory(nomCat);
    if (!cls) continue;
    base += TONY_NOM_WEIGHTS[cls.tier];
  }

  return Math.min(100, base);
}

/**
 * Apply the per-category Tony recipe.
 *   Best Musical:               0.4 critic + 0.6 audience
 *   Best Play:                  0.4 critic + 0.4 audience + 0.2 awards
 *   Best Revival of Musical:    1.0 audience
 *   Best Revival of Play:       1.0 audience
 *
 * Robustness: components whose value is null OR (for awards) zero are dropped
 * and the remaining weights are renormalized to sum to 1. So:
 *   - A musical with no audience data falls back to critic-only.
 *   - Best Play pre-precursor (every show's awardsScore is 0) becomes a true
 *     50/50 critic+audience composite — same numbers as the legacy blend, not
 *     just same ranking. This matters because the displayed score is the
 *     composite; without renormalization, all Best Plays would visibly jump
 *     ~10 points when precursor data lands.
 */
export function tonyComposite(
  criticScore: number | null,
  audienceGrade: number | null,
  awardsScore: number,
  categoryKey: TonyCategoryKey,
  tier: RecipeTier = 1,
): number | null {
  const r = getRecipe(categoryKey, tier);
  if (!r) return null;

  const components: Array<{ weight: number; value: number }> = [];
  if (r.critic > 0 && criticScore != null) components.push({ weight: r.critic, value: criticScore });
  if (r.audience > 0 && audienceGrade != null) components.push({ weight: r.audience, value: audienceGrade });
  // Drop the awards term when the show has no precursor signal — keeping
  // {weight: 0.2, value: 0} would multiply the result by 0.8 and create the
  // pre-precursor "score depression + jump" bug.
  if (r.awards > 0 && awardsScore > 0) components.push({ weight: r.awards, value: awardsScore });

  if (components.length === 0) return null;
  const total = components.reduce((s, c) => s + c.weight, 0);
  return components.reduce((s, c) => s + (c.weight / total) * c.value, 0);
}

/**
 * Serialize a show for the Tony Predictions UI.
 * Pass `categoryKey` to apply the per-category composite. Without it, falls back
 * to the legacy 50/50 critic+audience blend (used by the historical-winners
 * scroller and other places where category context isn't available).
 */
export function serializeShow(
  show: ComputedShow,
  categoryKey?: TonyCategoryKey,
  opts: { tier?: RecipeTier } = {},
): SerializedTonyShow {
  const buzz = getAudienceBuzz(show.id);
  const enoughAudience = buzz ? hasEnoughAudienceReviews(buzz) : false;
  const audScore = buzz?.combinedScore ?? null;

  const tonyAud = computeTonyAudienceGrade(show.id);
  const awards = categoryKey
    ? computeAwardsScore(show.id, CATEGORY_KEY_TO_TITLE[categoryKey])
    : 0;
  const composite = categoryKey
    ? tonyComposite(show.compositeScore, tonyAud, awards, categoryKey, opts.tier ?? 1)
    : legacyBlendedScore(show.compositeScore, enoughAudience ? audScore : null);

  // The displayed audience grade letter (A+, B-, etc.) must derive from the
  // SAME number that drives the predictor — otherwise users see an A+ on the
  // card while the model is ranking by a B+ input. For Tony pages we use the
  // tonyAudienceGrade (mean of Show Score + Mezzanine), falling back to the
  // site-wide combinedScore only when the categoryKey-less legacy path is
  // active (e.g. historical-winners scroller).
  const displayedAudScore = categoryKey ? tonyAud : (enoughAudience ? audScore : null);
  const audGrade = displayedAudScore != null ? getAudienceGrade(displayedAudScore) : null;

  return {
    slug: show.slug,
    title: show.title,
    venue: show.venue || '',
    openingDate: show.openingDate || '',
    previewsStartDate: show.previewsStartDate || undefined,
    status: show.status || '',
    compositeScore: show.compositeScore,
    reviewCount: show.criticScore?.reviewCount || 0,
    thumbnailPath: show.images?.thumbnail || null,
    audienceCombinedScore: audScore,
    audienceGrade: audGrade,
    blendedScore: composite,
    tonyAudienceGrade: tonyAud,
    awardsScore: awards,
    siteAwardsScore: computeSiteAwardScore(show.id).displayScore,
    tonyCategoryKey: categoryKey ?? null,
    gdOdds: categoryKey ? lookupGdOdds(show.id, CATEGORY_KEY_TO_TITLE[categoryKey]) : null,
    criticPicks: categoryKey ? lookupCriticPicks(show.id, null, CATEGORY_KEY_TO_TITLE[categoryKey]) : [],
    polymarketOdds: categoryKey ? lookupMarketOdds(show.title, CATEGORY_KEY_TO_TITLE[categoryKey], pmRawData) : null,
    kalshiOdds: categoryKey ? lookupMarketOdds(show.title, CATEGORY_KEY_TO_TITLE[categoryKey], kaRawData) : null,
    precursorWins: categoryKey ? getPrecursorWins(show.id, CATEGORY_KEY_TO_TITLE[categoryKey]) : [],
  };
}

/** Legacy 50/50 fallback for callers without a Tony category context. */
function legacyBlendedScore(criticScore: number | null, audienceScore: number | null): number | null {
  if (criticScore == null) return null;
  if (audienceScore == null) return criticScore;
  if (audienceScore < 0 || audienceScore > 100) return criticScore;
  return criticScore * 0.5 + audienceScore * 0.5;
}

function getTourStopSlugs(): Set<string> {
  const slugs = new Set<string>();
  const shows = (commercialData as Record<string, unknown>).shows as Record<string, { designation?: string }> | undefined;
  if (!shows) return slugs;
  for (const [slug, data] of Object.entries(shows)) {
    if (data.designation === 'Tour Stop') slugs.add(slug);
  }
  return slugs;
}

/**
 * Returns shows opening in the season window that were ruled ineligible by the
 * Tony Administration Committee. Rendered as a "Ruled ineligible" footer under
 * each prediction category — turns a confusing absence into a credibility win
 * (the site knows the rules). A show only appears here if its awards.json
 * entry has `tony.eligible === false` AND a `tony.note` explaining why.
 */
export function getIneligibleShows(allShows: ComputedShow[], season: TonySeasonWindow): IneligibleShow[] {
  const awardsSeason = toAwardsSeason(season.label);
  const awardsShows = getAwardsShows();
  const out: IneligibleShow[] = [];
  for (const show of allShows) {
    if (!show.openingDate) continue;
    if (show.openingDate < season.start || show.openingDate > season.end) continue;
    const ruling = awardsShows[show.id]?.tony;
    if (ruling?.season !== awardsSeason || ruling.eligible !== false) continue;
    if (!ruling.note) continue; // no explanation = don't surface
    let categoryKey: TonyCategoryKey;
    if (show.type === 'musical' && !show.isRevival) categoryKey = 'best-musical';
    else if (show.type === 'play' && !show.isRevival) categoryKey = 'best-play';
    else if (show.type === 'musical' && show.isRevival) categoryKey = 'best-revival-musical';
    else if (show.type === 'play' && show.isRevival) categoryKey = 'best-revival-play';
    else continue;
    out.push({ slug: show.slug, title: show.title, categoryKey, note: ruling.note });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export function getEligibleShows(allShows: ComputedShow[], season: TonySeasonWindow): ComputedShow[] {
  const tourStops = getTourStopSlugs();
  const awardsSeason = toAwardsSeason(season.label);
  return allShows.filter(show => {
    if (!show.openingDate) return false;
    if (show.openingDate < season.start || show.openingDate > season.end) return false;

    // Explicit Administration Committee ruling wins over heuristics. A `true`
    // ruling lets us include shows the tour-stop filter would otherwise drop
    // (e.g. mamma-mia). A `false` ruling excludes shows the heuristic would
    // otherwise admit (e.g. Just for Us — solo storytelling, Special Tony
    // recipient, never in competitive Best Play).
    const ruling = isTonyEligible(show.id, awardsSeason);
    if (ruling !== undefined) return ruling;

    if (tourStops.has(show.slug)) return false;
    return true;
  });
}

/**
 * Check if Tony nominations have been announced for a given season.
 * Requires at least 2 of the 4 main categories to have nominees
 * (avoids flipping to post-nom mode on partial data entry).
 */
export function hasNominationsBeenAnnounced(season: TonySeasonWindow): boolean {
  const awardsShows = getAwardsShows();
  const awardsSeason = toAwardsSeason(season.label);
  const categoriesWithNominees = new Set<string>();
  for (const [, data] of Object.entries(awardsShows)) {
    if (data.tony?.season !== awardsSeason) continue;
    const noms = data.tony?.nominatedFor || [];
    for (const n of noms) {
      if (TOP_CATEGORIES.includes(n as typeof TOP_CATEGORIES[number])) {
        categoriesWithNominees.add(n);
      }
    }
  }
  return categoriesWithNominees.size >= 2;
}

/**
 * Build a map of categoryTitle → Set<showId> for nominees in a given season.
 */
function getNomineesForSeason(season: TonySeasonWindow): Map<string, Set<string>> {
  const awardsShows = getAwardsShows();
  const awardsSeason = toAwardsSeason(season.label);
  const map = new Map<string, Set<string>>();
  for (const [showId, data] of Object.entries(awardsShows)) {
    if (data.tony?.season !== awardsSeason) continue;
    for (const cat of (data.tony?.nominatedFor || [])) {
      if (!map.has(cat)) map.set(cat, new Set());
      map.get(cat)!.add(showId);
    }
  }
  return map;
}

/**
 * Returns true once all three Best Play precursor winners (Drama Desk, Outer
 * Critics Circle, Drama League) are recorded in awards.json for the season —
 * the "precursor lock" point that the Tier 2 recipe was tuned for. Active
 * season auto-flips here; past seasons always return true (their winners
 * have long since been announced).
 */
export function shouldUseTier2(season: TonySeasonWindow): boolean {
  const awardsShows = getAwardsShows();
  const awardsSeason = toAwardsSeason(season.label);
  const present = { dramadesk: false, outerCriticsCircle: false, dramaLeague: false };
  for (const [, data] of Object.entries(awardsShows)) {
    if (data.tony?.season !== awardsSeason) continue;
    for (const k of ['dramadesk', 'outerCriticsCircle', 'dramaLeague'] as const) {
      const wins = (data as Record<string, unknown>)[k] as
        | { wins?: string[] }
        | undefined;
      if (wins?.wins && wins.wins.length > 0) present[k] = true;
    }
  }
  return present.dramadesk && present.outerCriticsCircle && present.dramaLeague;
}

/**
 * Resolve which recipe tier to use. Precedence:
 *   1. Explicit override (env TONY_RECIPE_TIER=1|2) — used by the audit script
 *      and any future temporary tier-2 evaluation.
 *   2. Per-season auto-flip via shouldUseTier2 — CURRENTLY DISABLED. The card
 *      that proposed the auto-flip (Notion 351637c5-...23a9) cited 95.2% Best
 *      Play accuracy under Tier 2 from a 2026-04-28 Phase 3 analysis. Sprint
 *      1's tier-weighted Awards Score (merged 2026-05-15) re-tuned the awards
 *      term enough that empirical re-test on 2026-05-16 shows Tier 2 at
 *      63.6% (7/11) vs Tier 1 at 90.9% (10/11) — leaning harder on awards
 *      hurts now. Re-tune Tier 2 weights for the new awards-score scale
 *      before re-enabling.
 *   3. Default tier 1.
 */
export function resolveRecipeTier(season?: TonySeasonWindow): RecipeTier {
  const envOverride = (typeof process !== 'undefined' && process.env?.TONY_RECIPE_TIER) || '';
  if (envOverride === '2') return 2;
  if (envOverride === '1') return 1;
  // Intentionally not calling shouldUseTier2(season) until weights re-tuned.
  // To re-enable auto-flip: uncomment the next line.
  // if (season && shouldUseTier2(season)) return 2;
  return 1;
}

export function groupIntoCategories(
  eligible: ComputedShow[],
  options?: { nomineesOnly?: boolean; season?: TonySeasonWindow; tier?: RecipeTier },
): TonyCategory[] {
  const categories: Array<{ key: TonyCategoryKey; title: string; description: string; filter: (s: ComputedShow) => boolean }> = [
    {
      key: 'best-musical',
      title: 'Best Musical',
      description: 'New musicals eligible for the top musical prize.',
      filter: (s: ComputedShow) => s.type === 'musical' && !s.isRevival,
    },
    {
      key: 'best-play',
      title: 'Best Play',
      description: 'New plays eligible for the top play prize.',
      filter: (s: ComputedShow) => s.type === 'play' && !s.isRevival,
    },
    {
      key: 'best-revival-musical',
      title: 'Best Revival of a Musical',
      description: 'Musical revivals competing for best revival honors.',
      filter: (s: ComputedShow) => s.type === 'musical' && !!s.isRevival,
    },
    {
      key: 'best-revival-play',
      title: 'Best Revival of a Play',
      description: 'Play revivals competing for best revival honors.',
      filter: (s: ComputedShow) => s.type === 'play' && !!s.isRevival,
    },
  ];

  // Build nominee map when filtering to nominees only
  const nomineeMap = options?.nomineesOnly && options.season
    ? getNomineesForSeason(options.season)
    : null;

  // Resolve recipe tier: explicit > season auto-flip > default 1.
  const effectiveTier: RecipeTier = options?.tier ?? resolveRecipeTier(options?.season);

  return categories.map(cat => {
    let matching: ComputedShow[];

    if (nomineeMap) {
      // In nomineesOnly mode, awards.json is authoritative on which show is in
      // which category — skip the isRevival/type filter so a show whose
      // isRevival flag is mis-set in shows.json (e.g. Eureka Day 2024 won
      // Best Revival of a Play but is flagged isRevival:false) still surfaces.
      const nomineeIds = nomineeMap.get(cat.title);
      if (nomineeIds && nomineeIds.size > 0) {
        matching = eligible.filter(s => nomineeIds.has(s.id));
      } else {
        // Fallback (no nominees yet for this category): use the type filter.
        matching = eligible.filter(cat.filter);
      }
    } else {
      matching = eligible.filter(cat.filter);
    }

    const scored = matching
      .filter(s => s.status !== 'previews' && s.status !== 'upcoming' && (s.criticScore?.reviewCount || 0) >= 5)
      .map(s => serializeShow(s, cat.key, { tier: effectiveTier }))
      .sort((a, b) => (b.blendedScore ?? -Infinity) - (a.blendedScore ?? -Infinity));

    // In nomineesOnly mode, all nominees should be scored (they've already opened),
    // so upcoming is empty. Otherwise, normal behavior.
    const upcoming = nomineeMap
      ? []
      : matching
          .filter(s => s.status === 'previews' || s.status === 'upcoming' || (s.criticScore?.reviewCount || 0) < 5)
          .sort((a, b) => (a.openingDate || '').localeCompare(b.openingDate || ''))
          .map(s => serializeShow(s, cat.key, { tier: effectiveTier }));

    return {
      key: cat.key,
      title: cat.title,
      description: cat.description,
      shows: scored,
      upcoming,
    };
  });
}

// --- Multi-Season Support ---

const TOP_CATEGORIES = ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'] as const;

type AwardsShowEntry = {
  tony?: {
    season?: string;
    wins?: string[];
    nominatedFor?: string[];
    nominations?: number;
    eligible?: boolean;
    note?: string;
  };
};

function getAwardsShows(): Record<string, AwardsShowEntry> {
  return (awardsData as Record<string, unknown>).shows as Record<string, AwardsShowEntry>;
}

export function getTonySeasonWindowFor(ceremonyYear: number): TonySeasonWindow {
  // Sourced from src/lib/tony-cutoffs.ts. For ceremony years outside the
  // tracked range (pre-2014 or speculative future years), fall back to the
  // standard April 28 → April 27 convention.
  const record = tonySeasonForCeremonyYear(ceremonyYear);
  if (record) return recordToWindow(record);
  return {
    start: `${ceremonyYear - 1}-04-28`,
    end: `${ceremonyYear}-04-27`,
    label: `${ceremonyYear - 1}-${ceremonyYear}`,
    ceremonyYear,
  };
}

/** Convert our label format to awards.json format: "2024-2025" → "2024-25" */
function toAwardsSeason(label: string): string {
  const parts = label.split('-');
  return `${parts[0]}-${parts[1].slice(2)}`;
}

/** Returns all seasons we generate prediction pages for, most recent first. */
export function getAllPredictionSeasons(): TonySeasonWindow[] {
  const current = getTonySeasonWindow();
  const seasons: TonySeasonWindow[] = [];
  for (let cy = FIRST_TRACKED_CEREMONY_YEAR; cy <= current.ceremonyYear; cy++) {
    seasons.push(getTonySeasonWindowFor(cy));
  }
  return seasons.reverse();
}

/**
 * For past seasons, derive eligible shows from awards.json nominees + opening date window.
 * This handles COVID seasons where the standard date window doesn't capture all nominees.
 */
export function getEligibleShowsForPastSeason(allShows: ComputedShow[], season: TonySeasonWindow): ComputedShow[] {
  const awardsShows = getAwardsShows();
  const showMap = new Map(allShows.map(s => [s.id, s]));
  const awardsSeason = toAwardsSeason(season.label);
  const eligible = new Map<string, ComputedShow>();

  // 1. Add all shows that have Tony data for this season in awards.json,
  //    EXCEPT those explicitly ruled ineligible by the Committee.
  for (const [showId, data] of Object.entries(awardsShows)) {
    if (data.tony?.season === awardsSeason && data.tony?.eligible !== false) {
      const show = showMap.get(showId);
      if (show) eligible.set(show.id, show);
    }
  }

  // 2. Also add shows from the standard date window (captures non-nominated eligible shows).
  //    getEligibleShows already honors isTonyEligible, so ineligible shows are filtered there.
  const dateEligible = getEligibleShows(allShows, season);
  for (const show of dateEligible) {
    eligible.set(show.id, show);
  }

  return Array.from(eligible.values());
}

/**
 * Build a map of categoryTitle → showId for Tony winners in a given season.
 * Sourced from awards.json, independent of how groupIntoCategories classifies
 * the show (some past winners have isRevival mis-flagged in shows.json).
 */
export function getWinnersForSeason(season: TonySeasonWindow): Map<string, string> {
  const awardsShows = getAwardsShows();
  const awardsSeason = toAwardsSeason(season.label);
  const map = new Map<string, string>();
  for (const [showId, data] of Object.entries(awardsShows)) {
    if (data.tony?.season !== awardsSeason) continue;
    const wins = data.tony?.wins || [];
    for (const cat of TOP_CATEGORIES) {
      if (wins.includes(cat as string)) map.set(cat as string, showId);
    }
  }
  return map;
}

/**
 * Get Tony outcomes for a season: slug → 'winner' | 'nominated'.
 * For past seasons: returns both winners and nominees.
 * For current season with nominations announced: returns 'nominated' for all nominees.
 * For current season pre-noms: returns empty.
 */
export function getSeasonOutcomes(allShows: ComputedShow[], season: TonySeasonWindow): Record<string, 'winner' | 'nominated'> {
  const current = getTonySeasonWindow();

  // Current/future season: show nominee badges if nominations announced
  if (season.ceremonyYear >= current.ceremonyYear) {
    if (!hasNominationsBeenAnnounced(season)) return {};
    const nominees = getNomineesForSeason(season);
    const showMap = new Map(allShows.map(s => [s.id, s]));
    const outcomes: Record<string, 'winner' | 'nominated'> = {};
    for (const [, showIds] of Array.from(nominees)) {
      for (const showId of Array.from(showIds)) {
        const show = showMap.get(showId);
        if (show && !outcomes[show.slug]) outcomes[show.slug] = 'nominated';
      }
    }
    return outcomes;
  }

  const awardsShows = getAwardsShows();
  const showMap = new Map(allShows.map(s => [s.id, s]));
  const awardsSeason = toAwardsSeason(season.label);
  const outcomes: Record<string, 'winner' | 'nominated'> = {};

  for (const [showId, data] of Object.entries(awardsShows)) {
    if (data.tony?.season !== awardsSeason) continue;
    const show = showMap.get(showId);
    if (!show) continue;

    const wins = data.tony?.wins || [];
    const noms = data.tony?.nominatedFor || [];

    const wonTopCategory = wins.some(w => TOP_CATEGORIES.includes(w as typeof TOP_CATEGORIES[number]));
    const nominatedTopCategory = noms.some(n => TOP_CATEGORIES.includes(n as typeof TOP_CATEGORIES[number]));

    if (wonTopCategory) {
      outcomes[show.slug] = 'winner';
    } else if (nominatedTopCategory) {
      outcomes[show.slug] = 'nominated';
    }
  }

  return outcomes;
}

// --- Accuracy Stats ---

export interface AccuracyStats {
  rank1WinPct: number;
  top2WinPct: number;
  avgWinnerRank: number;
  byCategory: Array<{ category: string; pct: number }>;
  newWorksAccuracy: number;
  revivalsAccuracy: number;
  fieldSizeData: Array<{ label: string; pct: number; note: string; count: number }>;
  upsets: Array<{ winner: string; season: string; category: string; rank: number }>;
  seasonCount: number;
  categorySeasonCount: number;
  skippedCount: number;
}

/** Category-aware scorer. Returns a ranking score (higher = better) for a show in a Tony category. */
type ShowScorer = (show: ComputedShow, categoryTitle: string) => number | null;

/** Map a top Tony category title back to its TonyCategoryKey, used by the accuracy scorer. */
function tonyCategoryKeyForTitle(title: string): TonyCategoryKey | null {
  switch (title) {
    case 'Best Musical': return 'best-musical';
    case 'Best Play': return 'best-play';
    case 'Best Revival of a Musical': return 'best-revival-musical';
    case 'Best Revival of a Play': return 'best-revival-play';
    default: return null;
  }
}

/** Build winners + nominees maps from awards.json (shared by all accuracy computations) */
function buildAwardsMaps() {
  const awardsShows = getAwardsShows();
  const winnersMap = new Map<string, string>();
  const nomineesMap = new Map<string, string[]>();

  for (const [showId, data] of Object.entries(awardsShows)) {
    if (!data.tony?.season) continue;
    const season = data.tony.season;
    const wins = data.tony.wins || [];
    const noms = data.tony.nominatedFor || [];

    for (const cat of TOP_CATEGORIES) {
      const catStr = cat as string;
      const key = `${season}|${catStr}`;
      if (wins.includes(catStr)) {
        winnersMap.set(key, showId);
        if (!nomineesMap.has(key)) nomineesMap.set(key, []);
        if (!nomineesMap.get(key)!.includes(showId)) nomineesMap.get(key)!.push(showId);
      }
      if (noms.includes(catStr)) {
        if (!nomineesMap.has(key)) nomineesMap.set(key, []);
        if (!nomineesMap.get(key)!.includes(showId)) nomineesMap.get(key)!.push(showId);
      }
    }
  }

  return { winnersMap, nomineesMap };
}

/** Internal: compute accuracy using a given scorer to rank nominees */
function computeAccuracyWithScorer(
  showMap: Map<string, ComputedShow>,
  seasons: TonySeasonWindow[],
  winnersMap: Map<string, string>,
  nomineesMap: Map<string, string[]>,
  scorer: ShowScorer,
): AccuracyStats {
  let totalCatSeasons = 0;
  let skipped = 0;
  let rank1Wins = 0;
  let top2Wins = 0;
  let totalWinnerRank = 0;
  const seasonSet = new Set<string>();
  const catResults: Record<string, { total: number; rank1: number }> = {};
  const fieldResults: Record<string, { total: number; rank1: number }> = {};
  const upsets: AccuracyStats['upsets'] = [];

  for (const cat of TOP_CATEGORIES) {
    catResults[cat] = { total: 0, rank1: 0 };
  }

  for (const season of seasons) {
    const awardsSeason = toAwardsSeason(season.label);

    for (const cat of TOP_CATEGORIES) {
      const key = `${awardsSeason}|${cat}`;
      const winnerShowId = winnersMap.get(key);
      if (!winnerShowId) continue;

      const winnerShow = showMap.get(winnerShowId);
      if (!winnerShow || scorer(winnerShow, cat) == null) {
        skipped++;
        continue;
      }

      // Main categories (Best Musical/Play/Revival) typically have 4-5 nominees
      const nomineeIds = nomineesMap.get(key) || [];
      const nomineeShows = nomineeIds
        .map(id => showMap.get(id))
        .filter((s): s is ComputedShow => s != null && scorer(s, cat) != null)
        .sort((a, b) => (scorer(b, cat) ?? 0) - (scorer(a, cat) ?? 0));

      if (nomineeShows.length < 2) {
        skipped++;
        continue;
      }

      const winnerRank = nomineeShows.findIndex(s => s.id === winnerShowId) + 1;
      if (winnerRank === 0) {
        skipped++;
        continue;
      }

      totalCatSeasons++;
      seasonSet.add(season.label);
      catResults[cat].total++;
      totalWinnerRank += winnerRank;

      const fieldSize = nomineeShows.length;
      let bucket: string;
      if (fieldSize <= 2) bucket = '2';
      else if (fieldSize <= 4) bucket = '3-4';
      else if (fieldSize <= 6) bucket = '5-6';
      else bucket = '7+';
      if (!fieldResults[bucket]) fieldResults[bucket] = { total: 0, rank1: 0 };
      fieldResults[bucket].total++;

      if (winnerRank === 1) {
        rank1Wins++;
        catResults[cat].rank1++;
        fieldResults[bucket].rank1++;
      }
      if (winnerRank <= 2) {
        top2Wins++;
      }
      if (winnerRank > 2) {
        upsets.push({
          winner: winnerShow.title,
          season: season.label,
          category: cat.replace('Best ', '').replace('Revival of a ', 'Revival '),
          rank: winnerRank,
        });
      }
    }
  }

  const byCategory = TOP_CATEGORIES.map(cat => ({
    category: cat.replace('Best ', '').replace('Revival of a ', 'Revival '),
    pct: catResults[cat].total > 0 ? Math.round((catResults[cat].rank1 / catResults[cat].total) * 100) : 0,
  }));

  const newCats = TOP_CATEGORIES.filter(c => !c.includes('Revival'));
  const revCats = TOP_CATEGORIES.filter(c => c.includes('Revival'));
  const newTotal = newCats.reduce((s, c) => s + catResults[c].total, 0);
  const newWins = newCats.reduce((s, c) => s + catResults[c].rank1, 0);
  const revTotal = revCats.reduce((s, c) => s + catResults[c].total, 0);
  const revWins = revCats.reduce((s, c) => s + catResults[c].rank1, 0);

  const fieldSizeData = [
    { label: '2 nominees', bucket: '2', note: 'Coin flip' },
    { label: '3\u20134 nominees', bucket: '3-4', note: 'Small field' },
    { label: '5\u20136 nominees', bucket: '5-6', note: 'Most common' },
  ].map(({ label, bucket, note }) => ({
    label,
    pct: fieldResults[bucket]?.total > 0 ? Math.round((fieldResults[bucket].rank1 / fieldResults[bucket].total) * 100) : 0,
    note,
    count: fieldResults[bucket]?.total || 0,
  }));

  return {
    rank1WinPct: totalCatSeasons > 0 ? Math.round((rank1Wins / totalCatSeasons) * 100) : 0,
    top2WinPct: totalCatSeasons > 0 ? Math.round((top2Wins / totalCatSeasons) * 100) : 0,
    avgWinnerRank: totalCatSeasons > 0 ? parseFloat((totalWinnerRank / totalCatSeasons).toFixed(2)) : 0,
    byCategory,
    newWorksAccuracy: newTotal > 0 ? Math.round((newWins / newTotal) * 100) : 0,
    revivalsAccuracy: revTotal > 0 ? Math.round((revWins / revTotal) * 100) : 0,
    fieldSizeData,
    upsets: upsets.sort((a, b) => b.season.localeCompare(a.season)),
    seasonCount: seasonSet.size,
    categorySeasonCount: totalCatSeasons,
    skippedCount: skipped,
  };
}

/**
 * Dynamically compute accuracy stats across all historical prediction seasons.
 * Ranks actual Tony NOMINEES by compositeScore and checks whether the
 * best-reviewed nominee wins.
 */
export interface BlendedAccuracyStats extends AccuracyStats {
  /** Headline blended stats (same as base rank1WinPct etc.) */
  blendedRank1WinPct: number;
  blendedTop2WinPct: number;
  blendedAvgWinnerRank: number;
  /** Critics-only headline for comparison */
  criticsOnlyRank1WinPct: number;
  improvement: number;
}

/**
 * Compute both critic-only and blended accuracy stats.
 * Returns blended stats as the base (fieldSizeData, byCategory, upsets, etc.),
 * plus critics-only headline for comparison.
 */
export function computeBlendedAccuracyStats(allShows: ComputedShow[]): BlendedAccuracyStats {
  const showMap = new Map(allShows.map(s => [s.id, s]));
  const current = getTonySeasonWindow();
  const seasons = getAllPredictionSeasons().filter(s => s.ceremonyYear < current.ceremonyYear);
  const { winnersMap, nomineesMap } = buildAwardsMaps();

  const criticStats = computeAccuracyWithScorer(showMap, seasons, winnersMap, nomineesMap,
    (show) => show.compositeScore);

  // The "blended" headline is now the per-category Tony composite (Awards Score
  // + critic + Tony audience grade). Pre-precursor it degenerates to 50/50
  // critic+audience for Best Play; for new musicals it's a 0.4/0.6 critic+aud
  // mix; for revivals it's audience-only. See TONY_RECIPES.
  const blendedStats = computeAccuracyWithScorer(showMap, seasons, winnersMap, nomineesMap,
    (show, catTitle) => {
      const key = tonyCategoryKeyForTitle(catTitle);
      if (!key) return null;
      const aud = computeTonyAudienceGrade(show.id);
      const awards = computeAwardsScore(show.id, catTitle);
      return tonyComposite(show.compositeScore, aud, awards, key);
    });

  return {
    ...blendedStats,
    blendedRank1WinPct: blendedStats.rank1WinPct,
    blendedTop2WinPct: blendedStats.top2WinPct,
    blendedAvgWinnerRank: blendedStats.avgWinnerRank,
    criticsOnlyRank1WinPct: criticStats.rank1WinPct,
    improvement: blendedStats.rank1WinPct - criticStats.rank1WinPct,
  };
}

// --- Season Summary (for overview page) ---

export interface TonySeasonSummary {
  season: TonySeasonWindow;
  eligibleCount: number;
  scoredCount: number;
  isCurrent: boolean;
  hasTonyResults: boolean;
  categoryHighlights: Array<{
    category: string;
    topShowTitle: string | null;
    topShowScore: number | null;
    winnerTitle: string | null;
  }>;
}

export function getSeasonSummary(allShows: ComputedShow[], season: TonySeasonWindow): TonySeasonSummary {
  const current = getTonySeasonWindow();
  const isCurrent = season.label === current.label;
  const isPast = season.ceremonyYear < current.ceremonyYear;
  const eligible = isPast ? getEligibleShowsForPastSeason(allShows, season) : getEligibleShows(allShows, season);
  const nominationsAnnounced = isCurrent && hasNominationsBeenAnnounced(season);
  // Use nomineesOnly mode whenever Tony nominees are known — same gate as the
  // per-season page. Without this, the overview-page summary cards can disagree
  // with the per-season page they link to (e.g. picking "Best Revival of a
  // Play" winner using shows.json's mis-set isRevival flag).
  const useNomineesOnly = !isCurrent || nominationsAnnounced;
  const categories = groupIntoCategories(eligible,
    useNomineesOnly ? { nomineesOnly: true, season } : undefined
  );

  const awardsShows = getAwardsShows();
  const showMap = new Map(allShows.map(s => [s.id, s]));
  const awardsSeason = toAwardsSeason(season.label);

  // Find winners per category for this season
  const winnersByCategory = new Map<string, string>();
  if (isPast) {
    for (const [showId, data] of Object.entries(awardsShows)) {
      if (data.tony?.season !== awardsSeason) continue;
      const wins = data.tony?.wins || [];
      for (const w of wins) {
        if (TOP_CATEGORIES.includes(w as typeof TOP_CATEGORIES[number])) {
          const show = showMap.get(showId);
          if (show) winnersByCategory.set(w, show.title);
        }
      }
    }
  }

  const categoryHighlights = categories.map(cat => {
    const catName = cat.title;
    const topShow = cat.shows[0] || null;
    return {
      category: catName.replace('Best ', '').replace('Revival of a ', 'Revival '),
      topShowTitle: topShow?.title || null,
      topShowScore: topShow?.blendedScore ?? topShow?.compositeScore ?? null,
      winnerTitle: winnersByCategory.get(catName) || null,
    };
  });

  return {
    season,
    eligibleCount: eligible.length,
    scoredCount: categories.reduce((sum, cat) => sum + cat.shows.length, 0),
    isCurrent,
    hasTonyResults: winnersByCategory.size > 0,
    categoryHighlights,
  };
}

// --- Historical Winners ---

export interface HistoricalWinner {
  slug: string;
  title: string;
  season: string;
  category: string;
  compositeScore: number | null;
  blendedScore: number | null;
  reviewCount: number;
}

export function getHistoricalWinners(allShows?: ComputedShow[]): HistoricalWinner[] {
  const shows = allShows || getBroadwayShows();
  const showMap = new Map(shows.map(s => [s.id, s]));
  const winners: HistoricalWinner[] = [];
  const awardsShows = (awardsData as Record<string, unknown>).shows as Record<string, {
    tony?: { season?: string; wins?: string[] };
  }>;

  for (const [showId, data] of Object.entries(awardsShows)) {
    const wins = data.tony?.wins || [];
    const topCategory = wins.find(w =>
      ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play'].includes(w)
    );
    if (!topCategory) continue;

    const show = showMap.get(showId);
    if (!show) continue;

    const catKey = tonyCategoryKeyForTitle(topCategory);
    const aud = computeTonyAudienceGrade(showId);
    const awards = catKey ? computeAwardsScore(showId, topCategory) : 0;
    const blended = catKey
      ? tonyComposite(show.compositeScore, aud, awards, catKey)
      : legacyBlendedScore(show.compositeScore, getAudienceBuzz(showId)?.combinedScore ?? null);

    winners.push({
      slug: show.slug,
      title: show.title,
      season: data.tony?.season || '',
      category: topCategory,
      compositeScore: show.compositeScore,
      blendedScore: blended,
      reviewCount: show.criticScore?.reviewCount || 0,
    });
  }

  return winners
    .sort((a, b) => b.season.localeCompare(a.season))
    .slice(0, 20);
}
