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
import { classifyCategory, type CategoryTier } from '@/lib/awards-scoring';

// Import commercial.json directly to avoid pulling in grosses-history.json
import commercialData from '../../data/commercial.json';
import awardsData from '../../data/awards.json';
import criticPicksRawData from '../../data/tony-critic-picks.json';
import tonyLosoStatsData from '../../data/tony-loso-stats.json';
import gdComparisonData from '../../data/analysis/gd-vs-broadwayscore.json';
import frozenAudienceData from '../../data/tony-frozen-audience-grades.json';

type CriticPicksFile = { picks: Record<string, Record<string, string>> };

const PERSON_MATCH_CATEGORIES = new Set([
  'Best Actor in a Musical', 'Best Actress in a Musical',
  'Best Actor in a Play', 'Best Actress in a Play',
  'Best Featured Actor in a Musical', 'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play', 'Best Featured Actress in a Play',
]);

/** Return outlet IDs whose critic predicted this show/person for the given category. */
export function lookupCriticPicks(showId: string, personName: string | null, tonyCategory: string): string[] {
  const data = criticPicksRawData as unknown as CriticPicksFile;
  const catPicks = data.picks[tonyCategory];
  if (!catPicks) return [];
  const isPersonCat = PERSON_MATCH_CATEGORIES.has(tonyCategory);
  const result: string[] = [];
  for (const [outletId, pick] of Object.entries(catPicks)) {
    if (isPersonCat) {
      if (personName && pick.toLowerCase() === personName.toLowerCase()) result.push(outletId);
    } else {
      if (pick === showId) result.push(outletId);
    }
  }
  return result;
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
export const TONY_RECIPES: Record<string, { critic: number; audience: number; awards: number }> = {
  // best-musical weights changed from 0.60/0.20/0.20 to 0.45/0.45/0.10 on
  // 2026-05-26 alongside the new categoryAwardsScore() for best-musical that
  // returns cast acting Tony noms count (normalized 0-100) instead of the
  // prior 50/50 topCat+broad precursor blend. Audit (--awards-sweep) reported
  // 11/11 LOSO on the historical sample with this recipe (vs 9/11 prior).
  //
  // Important nuance the ship-check audit surfaced: the cast-acting-noms
  // feature ALONE does not predict winners — 4 of 11 historical seasons had
  // a non-winner with the most acting noms (Jagged Little Pill 2019-20,
  // Some Like It Hot 2022-23, Hell's Kitchen 2023-24, Dead Outlaw 2024-25).
  // The 11/11 LOSO comes from the COMBINATION of cast-noms + the pre-existing
  // bestMusicalFeasibilityFactor (×0.85 penalty for shows without a Best
  // Direction of a Musical Tony nomination + same penalty for jukebox
  // musicals). Hell's Kitchen 2024 illustrates: raw composite 81.89 >
  // Outsiders 80.76, but no director nom → ×0.85 → 69.6 < Outsiders. The
  // director-nom penalty is what closes the prior 9/11 misses; the
  // cast-noms term contributes by providing a same-ballot voter-sentiment
  // re-anchor that activates after Tony nominations are announced.
  //
  // Honest framing: cast acting noms is a NOMINATION-DAY signal, not an
  // independent precursor. The Tony nominators and Tony voters are the same
  // body, so this feature partly re-uses the signal it's trying to predict.
  // Pre-Tony-nom-announcement, we fall back to the prior 50/50 topCat+broad
  // blend so year-round predictions stay sensible.
  //
  // All-11-season refit picks 0.45/0.45/0.10. Net total LOSO: 38/43 → 40/43
  // (93.0%). Parity impact on 2025-26: Schmigadoon top-1 stable but softmax
  // compresses (~58% → ~41%) since all 4 nominees have exactly 2 acting noms
  // (castNomsScore=50 for everyone); ranking power shifts to critic+audience.
  'best-musical':         { critic: 0.45, audience: 0.45, awards: 0.10 },
  // best-play weights changed to 0/0/1.0 on 2026-05-23 alongside the new
  // categoryAwardsScore() that combines two signals for this category:
  //   0.40 × topCatPrecursorScore (focused DL/OCC/DD Best Play win/nom)
  //   0.60 × blindedSiteLogScore  (broad: Pulitzer, NYDCC, Tony noms, etc.)
  // 11-season grid search shows this hits 11/11 in-sample with Brier 0.379,
  // better than the prior 10/11 (Brier 0.185 was sharper but missed Purpose
  // 2024-25 because the narrow precursor score didn't see Purpose's Pulitzer
  // and NYDCC wins). The recipe carries 100% awards weight because the broad
  // term already absorbs critic-reception signal via cross-cat awards from
  // OCC/DD/Lortel/Obie performer + craft votes — adding raw critic+audience
  // weight on top hurt Brier in the grid search.
  'best-play':            { critic: 0,    audience: 0,    awards: 1.0 },
  // best-revival-musical weights changed from 0.10/0.70/0.20 to 0.00/0.95/0.05
  // on 2026-05-25. Honest LOSO audit (scripts/audit-tony-loso.ts) showed the
  // prior recipe scored 8/10 leave-one-season-out; switching the per-fold
  // training objective from top-1 accuracy to log-loss (softmax T=7, the same
  // temperature used for the displayed "Our Pick %") perfects LOSO at 10/10.
  // Refitting on all 11 seasons under that objective produces 0.00/0.95/0.05.
  // Why log-loss helps THIS category: only 10 contests means discrete 0/1
  // accuracy gives the grid search a near-flat loss surface; log-loss is
  // smoother and recovers signal the accuracy objective lost. 300-permutation
  // null test confirms p < 0.003 against shuffled-winner data. The change
  // alone moves total LOSO from 36/43 (83.7%) to 38/43 (88.4%). Parity-checked
  // on 2025-26: ragtime remains #1 (93.3 vs cats-the-jellicle-ball 87.3). The
  // shift from 20% awards weight to 5% accepts a smaller Brier margin in
  // exchange for a real out-of-sample accuracy gain.
  'best-revival-musical': { critic: 0.00, audience: 0.95, awards: 0.05 },
  // best-revival-play weights changed from 0/1.0/0 to 0.20/0.60/0.20 on
  // 2026-05-21. The previous pure-audience recipe matched 10/11 historically
  // but produced a top-1 score gap of only 0.5pt on 2025-26: Every Brilliant
  // Thing (aud=90, no precursor wins, aws=18) beat Death of a Salesman (aud=
  // 89.5, full DL+OCC+DD precursor sweep, aws=100). Kalshi 84%, GoldDerby 89%,
  // and 2 of 3 critic picks all had DoS — and EBT at the T=7 softmax sat at
  // 24% (markets had it ~1%). The historical sample never contained a "no
  // awards, high audience" outlier like EBT, so audience-only over-rewards
  // it. The 0.20/0.60/0.20 mix gives DoS a 14pt scoring margin (75% vs 6%
  // post-softmax), at a cost of 2 historical seasons (Boys in the Band
  // 2018-19, A Raisin in the Sun 2013-14 — both genuine upsets in the
  // historical record). Net: 8/11 (72.7%) in-sample, but the lost seasons
  // were upset-favored already and the recipe is more robust to
  // EBT-style outliers. Verified with scripts/audit-tony-all-seasons.ts.
  'best-revival-play':    { critic: 0.20, audience: 0.60, awards: 0.20 },
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
  'best-musical':         { critic: 0.4, audience: 0.6, awards: 0   },
  'best-play':            { critic: 0.2, audience: 0.2, awards: 0.6 },
  'best-revival-musical': { critic: 0,   audience: 1.0, awards: 0   },
  'best-revival-play':    { critic: 0,   audience: 1.0, awards: 0   },
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
  // Direction
  'Best Direction of a Musical': {
    dramadesk: ['Outstanding Direction of a Musical', 'Outstanding Director of a Musical'],
    outerCriticsCircle: ['Outstanding Direction of a Musical', 'Outstanding Director of a Musical', 'Outstanding Director of Musical'],
    dramaLeague: ['Outstanding Direction of a Musical'],
  },
  'Best Direction of a Play': {
    dramadesk: ['Outstanding Direction of a Play', 'Outstanding Director of a Play'],
    outerCriticsCircle: ['Outstanding Direction of a Play', 'Outstanding Director of a Play', 'Outstanding Director of Play'],
    dramaLeague: ['Outstanding Direction of a Play'],
  },
  // Craft
  'Best Book of a Musical': {
    dramadesk: ['Outstanding Book of a Musical'],
    outerCriticsCircle: ['Outstanding Book of a Musical', 'Outstanding Book of a Musical (Broadway or Off-Broadway)'],
    dramaLeague: [],
  },
  'Best Original Score': {
    dramadesk: ['Outstanding Music', 'Outstanding Lyrics', 'Outstanding New Score'],
    outerCriticsCircle: ['Outstanding New Score', 'Outstanding Score'],
    dramaLeague: [],
  },
  'Best Choreography': {
    dramadesk: ['Outstanding Choreography'],
    outerCriticsCircle: ['Outstanding Choreographer', 'Outstanding Choreography'],
    dramaLeague: [],
  },
  // Acting categories — DL "Distinguished Performance Award" is per-performer
  // (one winner across all 8 Tony acting categories per year). Listing it under
  // all 8 mappings is required so the chip CAN render for any winner; the
  // getPrecursorWins() filter then uses `dramaLeague.winnerNames` to ensure
  // the chip only appears next to the actual performer, not every nominee
  // from that show.
  // Lead acting
  'Best Actor in a Musical': {
    dramadesk: ['Outstanding Actor in a Musical', 'Outstanding Lead Performance in a Musical'],
    outerCriticsCircle: ['Outstanding Actor in a Musical', 'Outstanding Lead Performer in a Broadway Musical'],
    dramaLeague: ['Distinguished Performance Award'],
  },
  'Best Actress in a Musical': {
    dramadesk: ['Outstanding Actress in a Musical', 'Outstanding Lead Performance in a Musical'],
    outerCriticsCircle: ['Outstanding Actress in a Musical', 'Outstanding Lead Performer in a Broadway Musical'],
    dramaLeague: ['Distinguished Performance Award'],
  },
  'Best Actor in a Play': {
    dramadesk: ['Outstanding Actor in a Play', 'Outstanding Lead Performance in a Play'],
    outerCriticsCircle: ['Outstanding Actor in a Play', 'Outstanding Lead Performer in a Broadway Play'],
    dramaLeague: ['Distinguished Performance Award'],
  },
  'Best Actress in a Play': {
    dramadesk: ['Outstanding Actress in a Play', 'Outstanding Lead Performance in a Play'],
    outerCriticsCircle: ['Outstanding Actress in a Play', 'Outstanding Lead Performer in a Broadway Play'],
    dramaLeague: ['Distinguished Performance Award'],
  },
  // Featured acting
  'Best Featured Actor in a Musical': {
    dramadesk: ['Outstanding Featured Actor in a Musical', 'Outstanding Featured Performance in a Musical'],
    outerCriticsCircle: ['Outstanding Featured Actor in a Musical', 'Outstanding Featured Performer in a Broadway Musical'],
    dramaLeague: ['Distinguished Performance Award'],
  },
  'Best Featured Actress in a Musical': {
    dramadesk: ['Outstanding Featured Actress in a Musical', 'Outstanding Featured Performance in a Musical'],
    outerCriticsCircle: ['Outstanding Featured Actress in a Musical', 'Outstanding Featured Performer in a Broadway Musical'],
    dramaLeague: ['Distinguished Performance Award'],
  },
  'Best Featured Actor in a Play': {
    dramadesk: ['Outstanding Featured Actor in a Play', 'Outstanding Featured Performance in a Play'],
    outerCriticsCircle: ['Outstanding Featured Actor in a Play', 'Outstanding Featured Performer in a Broadway Play'],
    dramaLeague: ['Distinguished Performance Award'],
  },
  'Best Featured Actress in a Play': {
    dramadesk: ['Outstanding Featured Actress in a Play', 'Outstanding Featured Performance in a Play'],
    outerCriticsCircle: ['Outstanding Featured Actress in a Play', 'Outstanding Featured Performer in a Broadway Play'],
    dramaLeague: ['Distinguished Performance Award'],
  },
};

/** Acting award categories that are given to a specific performer, not a show.
 *  When winnerNames is present in awards.json, chips are attributed only to the actual winner.
 *  Without winnerNames, falls back to show-level (chip shows for all nominees from the show). */
const DL_PER_PERFORMER_AWARDS = new Set(['Distinguished Performance Award']);
const OCC_PER_PERFORMER_AWARDS = new Set([
  'Outstanding Actor in a Musical', 'Outstanding Actress in a Musical',
  'Outstanding Actor in a Play', 'Outstanding Actress in a Play',
  'Outstanding Lead Performer in a Broadway Musical', 'Outstanding Lead Performer in a Broadway Play',
  'Outstanding Featured Actor in a Musical', 'Outstanding Featured Actress in a Musical',
  'Outstanding Featured Actor in a Play', 'Outstanding Featured Actress in a Play',
  'Outstanding Featured Performer in a Broadway Musical', 'Outstanding Featured Performer in a Broadway Play',
]);
const DD_PER_PERFORMER_AWARDS = new Set([
  'Outstanding Actor in a Musical', 'Outstanding Actress in a Musical',
  'Outstanding Actor in a Play', 'Outstanding Actress in a Play',
  'Outstanding Lead Performance in a Musical', 'Outstanding Lead Performance in a Play',
  'Outstanding Featured Actor in a Musical', 'Outstanding Featured Actress in a Musical',
  'Outstanding Featured Actor in a Play', 'Outstanding Featured Actress in a Play',
  'Outstanding Featured Performance in a Musical', 'Outstanding Featured Performance in a Play',
]);

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
  /** 0-100 Awards Score from precursor nominations (Drama League, OCC, Drama Desk). */
  awardsScore: number;
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
  /** Day-over-day change in GoldDerby odds (positive = up, negative = down). Null if no prior day. */
  gdOddsChange?: number | null;
  /** Day-over-day change in Polymarket odds. */
  polymarketOddsChange?: number | null;
  /** Day-over-day change in Kalshi odds. */
  kalshiOddsChange?: number | null;
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
/**
 * Frozen audience grades for shows in COMPLETED Tony seasons. Once a season is
 * over, its nominees' audience grades are snapshotted here (oldest value we
 * have, closest to ceremony time) so post-ceremony rating drift can no longer
 * re-rank past seasons or move the published track-record accuracy. New ratings
 * of a years-old show are irrelevant to that season's Tony race. The current
 * season is intentionally absent — it stays on live data until it completes,
 * then gets frozen by scripts/freeze-tony-audience-grades.ts. See that script.
 */
const FROZEN_TONY_AUDIENCE: Record<string, { grade: number; season: string }> =
  (frozenAudienceData as { grades?: Record<string, { grade: number; season: string }> }).grades ?? {};

export function computeTonyAudienceGrade(showId: string): number | null {
  const frozen = FROZEN_TONY_AUDIENCE[showId];
  if (frozen && typeof frozen.grade === 'number') return frozen.grade;

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
  return Math.min(100, base);
}

/**
 * Top-category precursor score — focused on just the equivalent top award
 * at the three precursor ceremonies (DL, OCC, DD).
 *
 *   +30 × tier per top-cat WIN
 *   +10 × tier per top-cat NOM (no win)
 *
 * Tier weights: DL=1.0, OCC=0.9, DD=0.7. Max 78 (full sweep wins).
 *
 * This is a NARROWER signal than computeAwardsScore (which also includes a
 * cross-category nom tail). Used by Best Play recipe as one of two awards
 * inputs alongside blindedSiteLogScore. 11-season backtest 2026-05-23 shows
 * combining these two signals beats either alone for Best Play (11/11 + Brier
 * 0.379 vs broad-only 11/11 + 1.335 vs topCat-only 10/11 + 0.801).
 */
export function topCatPrecursorScore(showId: string, tonyCategory: string): number {
  const shows = (awardsData as Record<string, unknown>).shows as Record<string, AwardsShowEntry & {
    dramadesk?: PrecursorNode;
    outerCriticsCircle?: PrecursorNode;
    dramaLeague?: PrecursorNode;
  }>;
  const entry = shows[showId];
  if (!entry) return 0;
  const matching = TONY_TO_PRECURSOR_CATEGORY[tonyCategory];
  if (!matching) return 0;
  const sources = [
    { node: entry.dramaLeague,        matchCats: matching.dramaLeague,        tier: PRECURSOR_TIER_WEIGHTS.dramaLeague },
    { node: entry.outerCriticsCircle, matchCats: matching.outerCriticsCircle, tier: PRECURSOR_TIER_WEIGHTS.outerCriticsCircle },
    { node: entry.dramadesk,          matchCats: matching.dramadesk,          tier: PRECURSOR_TIER_WEIGHTS.dramadesk },
  ];
  let score = 0;
  for (const { node, matchCats, tier } of sources) {
    if (!node) continue;
    const wins = node.wins ?? [];
    const noms = node.nominatedFor ?? [];
    if (matchCats.some((c) => wins.includes(c))) score += 30 * tier;
    else if (matchCats.some((c) => noms.includes(c))) score += 10 * tier;
  }
  return score;
}

/**
 * Blinded Site Award Score — the site's prestige score (awards-scoring.ts
 * computeSiteAwardScore) but with the show's own Tony WINS masked out to
 * prevent leakage in historical backtests and to keep the value usable as a
 * predictor for current-season nominees (Tony noms ARE allowed; they're
 * announced before the ceremony).
 *
 * Includes Tony noms, Pulitzer wins/finalists, NYDCC wins, OCC, DL, DD,
 * Olivier, Obie, Lortel — full ceremony breadth. Same log scale as site
 * (40 * log10(1 + rawPoints/4), capped at 100).
 *
 * Used by Best Play recipe alongside topCatPrecursorScore (broad + narrow
 * signals capture independent information per 11-season backtest).
 */
export function blindedSiteLogScore(showId: string): number {
  // Lazy import to avoid circular dep: awards-scoring imports nothing from
  // this module, but we want the same POINTS table and ceremony aggregation
  // logic. Re-implement the scoring loop inline with Tony WINS masked.
  const shows = (awardsData as Record<string, unknown>).shows as Record<string, AwardsShowEntry & {
    dramadesk?: PrecursorNode; outerCriticsCircle?: PrecursorNode; dramaLeague?: PrecursorNode;
    pulitzer?: { wins?: string[]; finalist?: string[] };
    pulitzerFinalist?: { year?: number; note?: string };
    olivier?: PrecursorNode;
    nyDramaCritics?: { wins?: string[]; noAward?: boolean };
    obie?: PrecursorNode;
    lortel?: PrecursorNode;
  }>;
  const entry = shows[showId];
  if (!entry) return 0;

  // Local copy of the POINTS table from awards-scoring.ts. Kept in sync by
  // the awards-cap follow-up Notion card; if the site table changes, this
  // mirror must too.
  const POINTS: Record<string, Partial<Record<CategoryTier, { win: number; nom: number }>>> = {
    tony:         { S: { win: 200, nom: 20 }, A: { win: 75, nom: 9 }, B: { win: 35, nom: 5 }, C: { win: 25, nom: 3 } },
    pulitzer:     { S: { win: 110, nom: 18 } },
    olivier_bway: { S: { win: 50,  nom: 6 },  A: { win: 25, nom: 3 },  B: { win: 15, nom: 2 }, C: { win: 12, nom: 2 } },
    nydcc:        { S: { win: 45,  nom: 0 } },
    occ:          { S: { win: 30,  nom: 5 },  A: { win: 20, nom: 3 },  B: { win: 12, nom: 2 }, C: { win: 8,  nom: 1 } },
    dramaLeague:  { S: { win: 35,  nom: 5 },  A: { win: 22, nom: 3 } },
    dramaDesk:    { S: { win: 28,  nom: 4 },  A: { win: 18, nom: 2 },  B: { win: 12, nom: 2 }, C: { win: 8,  nom: 1 } },
    obie:         { S: { win: 18,  nom: 0 },  A: { win: 12, nom: 0 },  B: { win: 8,  nom: 0 }, C: { win: 5,  nom: 0 } },
    lortel:       { S: { win: 20,  nom: 3 },  A: { win: 12, nom: 2 },  B: { win: 8,  nom: 1 }, C: { win: 5,  nom: 1 } },
  };
  const A_PLUS_MULT = 1.2, REVIVAL_DISC = 0.85;
  const C_STACK = [1.0, 0.7, 0.5, 0.4, 0.4, 0.4];
  const pickTier = (t: Partial<Record<CategoryTier, { win: number; nom: number }>>, tier: CategoryTier) => {
    if (tier === 'A+') return t.A ?? null;
    return t[tier] ?? null;
  };
  const applyMult = (p: number, tier: CategoryTier, rev: boolean) => {
    if (tier === 'A+') p *= A_PLUS_MULT;
    if (rev) p *= REVIVAL_DISC;
    return p;
  };
  const scoreCeremony = (key: string, wins: string[], noms: string[], maskWins = false): number => {
    const table = POINTS[key];
    if (!table) return 0;
    let total = 0, cWinsSeen = 0;
    if (!maskWins) {
      const winCount: Record<string, number> = {};
      for (const w of wins) winCount[w] = (winCount[w] ?? 0) + 1;
      for (const [cat, count] of Object.entries(winCount)) {
        const cls = classifyCategory(cat);
        if (!cls) continue;
        const pts = pickTier(table, cls.tier);
        if (!pts) continue;
        for (let i = 0; i < count; i++) {
          let raw = pts.win;
          if (cls.tier === 'C') { raw *= C_STACK[Math.min(cWinsSeen, C_STACK.length - 1)]; cWinsSeen++; }
          total += applyMult(raw, cls.tier, cls.revival);
        }
      }
    }
    const nomCount: Record<string, number> = {};
    for (const n of noms) nomCount[n] = (nomCount[n] ?? 0) + 1;
    const winCount2: Record<string, number> = {};
    if (!maskWins) for (const w of wins) winCount2[w] = (winCount2[w] ?? 0) + 1;
    for (const [cat, count] of Object.entries(nomCount)) {
      const cls = classifyCategory(cat);
      if (!cls) continue;
      const pts = pickTier(table, cls.tier);
      if (!pts || pts.nom <= 0) continue;
      const losing = Math.max(0, count - (winCount2[cat] ?? 0));
      for (let i = 0; i < losing; i++) total += applyMult(pts.nom, cls.tier, cls.revival);
    }
    return total;
  };

  let raw = 0;
  if (entry.tony)             raw += scoreCeremony('tony',         entry.tony.wins ?? [],             entry.tony.nominatedFor ?? [],             true);
  if (entry.pulitzer)         raw += scoreCeremony('pulitzer',     entry.pulitzer.wins ?? [],         entry.pulitzer.finalist ?? [],             false);
  if (entry.olivier)          raw += scoreCeremony('olivier_bway', entry.olivier.wins ?? [],          entry.olivier.nominatedFor ?? [],          false);
  if (entry.nyDramaCritics)   raw += scoreCeremony('nydcc',        entry.nyDramaCritics.wins ?? [],   [],                                         false);
  if (entry.outerCriticsCircle) raw += scoreCeremony('occ',        entry.outerCriticsCircle.wins ?? [], entry.outerCriticsCircle.nominatedFor ?? [], false);
  if (entry.dramaLeague)      raw += scoreCeremony('dramaLeague',  entry.dramaLeague.wins ?? [],      entry.dramaLeague.nominatedFor ?? [],      false);
  if (entry.dramadesk)        raw += scoreCeremony('dramaDesk',    entry.dramadesk.wins ?? [],        entry.dramadesk.nominatedFor ?? [],        false);
  if (entry.obie)             raw += scoreCeremony('obie',         entry.obie.wins ?? [],             [],                                         false);
  if (entry.lortel)           raw += scoreCeremony('lortel',       entry.lortel.wins ?? [],           entry.lortel.nominatedFor ?? [],           false);
  return Math.max(0, Math.min(100, 40 * Math.log10(1 + raw / 4)));
}

/**
 * Dispatcher: returns the awards-term value for a given category.
 *
 * For 'best-play' (2026-05-23): combines two signals discovered by 11-season
 * grid search to be jointly more predictive than either alone:
 *   0.40 × topCatPrecursorScore (focused: DL/OCC/DD Best Play wins/noms)
 *   0.60 × blindedSiteLogScore  (broad: Pulitzer, NYDCC, Tony noms, Olivier, etc.)
 * In-sample accuracy 11/11 (vs current 10/11). Fixes the Purpose 2024-25 miss
 * because Purpose won Pulitzer + NYDCC + DD Outstanding Play but lost DL+OCC
 * top-cat — the broad signal captures what the narrow signal misses.
 *
 * For other categories: returns the legacy computeAwardsScore (narrow,
 * precursor-only). Grid search showed the two-signal combination doesn't help
 * or marginally hurts the other 3 categories on the 11-season backtest.
 */
export function categoryAwardsScore(showId: string, categoryKey: TonyCategoryKey): number {
  if (categoryKey === 'best-play') {
    const tc = topCatPrecursorScore(showId, CATEGORY_KEY_TO_TITLE['best-play']);
    const broad = blindedSiteLogScore(showId);
    return 0.40 * tc + 0.60 * broad;
  }
  // best-musical (2026-05-26): awards term is now cast acting Tony noms
  // count, normalized 0-100. Audit (scripts/audit-tony-loso.ts --awards-sweep)
  // showed this lifts best-musical LOSO from 9/11 to 11/11 — the two prior
  // misses (Outsiders 2024-25 over Suffs; Dear Evan Hansen 2017 over Come
  // From Away) were both "voter-love" upsets that cast acting noms count
  // captures more cleanly than precursor wins. See also
  // `castActingNomsCountScore` and Notion 36c637c5-416f-8176-946e-fefa2705c1cd.
  //
  // Pre-Tony-nomination-announcement (no tony.nominatedFor in awards.json for
  // the current season's shows), we fall back to the prior 50/50 topCat+broad
  // blend so year-round predictions stay sensible. The fallback fires when
  // the show has zero nominatedFor entries.
  if (categoryKey === 'best-musical') {
    const entry = getAwardsShows()[showId];
    const hasAnyTonyNoms = (entry?.tony?.nominatedFor?.length ?? 0) > 0;
    if (hasAnyTonyNoms) {
      return castActingNomsCountScore(showId);
    }
    const tc = topCatPrecursorScore(showId, CATEGORY_KEY_TO_TITLE['best-musical']);
    const broad = blindedSiteLogScore(showId);
    return 0.50 * tc + 0.50 * broad;
  }
  // best-revival-musical (2026-05-23): adding 20% broad weight to the audience-
  // heavy recipe improves Brier (3.901 -> 3.417) while preserving 10/10
  // in-sample accuracy. Hedges against the audience-grade post-Tony bias
  // (historical winners accumulated reviews from voters who knew they won).
  if (categoryKey === 'best-revival-musical') {
    return blindedSiteLogScore(showId);
  }
  return computeAwardsScore(showId, CATEGORY_KEY_TO_TITLE[categoryKey]);
}

/** Return 'DL', 'OCC', and/or 'DD' if the show won matching precursor categories. */
export function getPrecursorWins(showId: string, tonyCategory: string, nomineeName?: string | null): string[] {
  const shows = (awardsData as Record<string, unknown>).shows as Record<string, {
    dramadesk?: { wins?: string[]; winnerNames?: Record<string, string[]> };
    outerCriticsCircle?: { wins?: string[]; winnerNames?: Record<string, string[]> };
    dramaLeague?: { wins?: string[]; winnerNames?: Record<string, string[]> };
  }>;
  const entry = shows[showId];
  if (!entry) return [];
  const matching = TONY_TO_PRECURSOR_CATEGORY[tonyCategory];
  if (!matching) return [];

  // Generic check: a per-performer award (in perPersonSet) uses winnerNames when
  // populated to attribute the chip to the correct person. Without winnerNames, falls
  // back to show-level behavior (chip shows for all nominees from the winning show).
  // Show-level awards (not in perPersonSet) always show the chip regardless.
  function checkCeremony(
    wins: string[] | undefined,
    winnerNames: Record<string, string[]> | undefined,
    categories: string[],
    perPersonSet: Set<string>,
  ): boolean {
    const matched = categories.filter(c => (wins ?? []).includes(c));
    if (matched.length === 0) return false;
    return matched.some(c => {
      if (!perPersonSet.has(c)) return true;  // show-level award — always show
      const winners = winnerNames?.[c];
      if (!winners || winners.length === 0) return true;  // no winner data — fall back to show-level
      if (!nomineeName) return true;  // no person context — show chip
      return winners.includes(nomineeName);  // disambiguate: show only for the actual winner
    });
  }

  const result: string[] = [];
  if (checkCeremony(entry.dramaLeague?.wins, entry.dramaLeague?.winnerNames, matching.dramaLeague, DL_PER_PERFORMER_AWARDS)) result.push('DL');
  if (checkCeremony(entry.outerCriticsCircle?.wins, entry.outerCriticsCircle?.winnerNames, matching.outerCriticsCircle, OCC_PER_PERFORMER_AWARDS)) result.push('OCC');
  if (checkCeremony(entry.dramadesk?.wins, entry.dramadesk?.winnerNames, matching.dramadesk, DD_PER_PERFORMER_AWARDS)) result.push('DD');
  return result;
}

/**
 * Apply the per-category Tony recipe. Current shipped recipes are in
 * TONY_RECIPES (Tier 1) and TONY_RECIPES_TIER2 above — see those constants
 * for the authoritative weights; this docblock used to inline them and went
 * stale.
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

  // Dominant-audience-null fallback. For categories where the recipe puts
  // more than half the weight on audience (currently best-revival-musical
  // at 0.95), a show with no Show Score + Mezzanine coverage would have
  // audience dropped and the remaining 5% awards renormalized to 100% —
  // a degenerate "judged on a single precursor signal" score that doesn't
  // reflect the show's actual reception. When audience is the dominant
  // signal and missing, fall back to a 50/50 critic + awards blend so the
  // score is at least anchored to two independent inputs. Today this is
  // latent (all 2025-26 revival musical nominees have audience data); the
  // guard exists for the next revival musical without audience coverage.
  if (r.audience > 0.5 && audienceGrade == null) {
    const fallback: Array<{ weight: number; value: number }> = [];
    if (criticScore != null) fallback.push({ weight: 0.5, value: criticScore });
    if (awardsScore > 0) fallback.push({ weight: 0.5, value: awardsScore });
    if (fallback.length === 0) return null;
    const ft = fallback.reduce((s, c) => s + c.weight, 0);
    return fallback.reduce((s, c) => s + (c.weight / ft) * c.value, 0);
  }

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
 * Structural feasibility filter for Best Musical categories — multiplicative
 * penalty applied to the composite for shows whose category history says they
 * essentially cannot win.
 *
 * Applies to BOTH best-musical AND best-revival-musical:
 *   1. No Best Direction of a Musical nom → ×0.85
 *      best-musical:         11/11 winners had a director nom (0/14 ever won
 *                            without). best-revival-musical: 10/10 winners
 *                            had one (0/16 ever won without). Tony voters
 *                            who think a musical is the year's best also
 *                            nominate its director.
 *
 * Applies to best-musical only:
 *   2. Jukebox musical AND not pandemic season → ×0.85
 *      Excluding the COVID-shortened 2019–20 ceremony (where Moulin Rouge won
 *      a 3-nominee field), zero jukebox musicals won Best Musical in the 11
 *      tracked seasons. Tony voters consistently snub the form. (Jukebox
 *      penalty does not apply to revival musicals — limited sample size and
 *      revival audiences differ.)
 *
 * Penalties stack multiplicatively. A jukebox with no director nom (e.g.
 * Titaníque 2025–26) drops by ~28% (×0.7225 = ×0.85 × ×0.85), landing at
 * ~1.5% in the T=7 softmax. Earlier ×0.10 was too harsh (read as bug).
 * Pandemic exception is hardcoded to season label '2019-2020'.
 *
 * Returns 1.0 (no penalty) for non-Musical categories.
 */
export function bestMusicalFeasibilityFactor(
  showId: string,
  tags: string[],
  categoryKey: TonyCategoryKey,
  seasonLabel: string,
): number {
  if (categoryKey !== 'best-musical' && categoryKey !== 'best-revival-musical') return 1.0;
  // Pandemic exception — the 2019-20 ceremony was COVID-truncated (only 3
  // nominees announced months late) and Moulin Rouge winning is an outlier
  // that should not penalize future jukebox nominees.
  const PANDEMIC_SEASONS = new Set(['2019-2020']);
  if (PANDEMIC_SEASONS.has(seasonLabel)) return 1.0;

  const shows = (awardsData as Record<string, unknown>).shows as Record<string, AwardsShowEntry>;
  const entry = shows[showId];
  const hasDirectorNom =
    entry?.tony?.nominatedFor?.includes('Best Direction of a Musical') ?? false;

  let factor = 1.0;
  if (!hasDirectorNom) factor *= 0.85;
  // Jukebox penalty applies only to best-musical (new-work category).
  if (categoryKey === 'best-musical') {
    const isJukebox = tags.includes('jukebox');
    if (isJukebox) factor *= 0.85;
  }
  return factor;
}

/**
 * Cast acting Tony nominations count, normalized 0-100.
 *
 * For a show in a given Tony category, counts how many of its cast members
 * received Tony nominations in the 8 acting categories (Lead / Featured ×
 * Actor / Actress × Musical / Play). More acting noms = stronger "voters
 * institutionally love this production" signal beyond what the show's own
 * top-cat precursor wins capture.
 *
 * Returns null pre-Tony-nomination-announcement (no data yet). Returns a
 * 0-100 score post-noms, normalized against a per-category ceiling derived
 * from the maximum plausible acting nom count for that show type.
 *
 *   musicals: 4 lead + 4 featured slots = 8 ceiling, but realistic max ~4
 *   plays:    4 lead + 4 featured slots = 8 ceiling, realistic max ~4
 * We use ceiling = 4 for both — a show with 4+ acting noms scores 100.
 *
 * Pre-nom callers must check `hasNominationsBeenAnnounced(season)` first and
 * either skip this feature or handle the null fall-back via the recipe's
 * existing null-drop logic in tonyComposite.
 */
const ACTING_TONY_CATEGORIES = new Set([
  'Best Actor in a Musical', 'Best Actress in a Musical',
  'Best Actor in a Play', 'Best Actress in a Play',
  'Best Featured Actor in a Musical', 'Best Featured Actress in a Musical',
  'Best Featured Actor in a Play', 'Best Featured Actress in a Play',
]);

/** Count the show's cast Tony acting noms, no timing gate. Returns 0 if no
 *  data. Used internally by both `castActingNomsScore` (timing-gated wrapper
 *  for direct callers) and `categoryAwardsScore` (which has its own gate). */
function castActingNomsCountScore(showId: string): number {
  const entry = getAwardsShows()[showId];
  if (!entry) return 0;
  const noms = entry.tony?.nominatedFor || [];
  let count = 0;
  for (const n of noms) {
    if (ACTING_TONY_CATEGORIES.has(n)) count++;
  }
  const CEILING = 4;
  return Math.min(100, (count / CEILING) * 100);
}

export function castActingNomsScore(
  showId: string,
  season: TonySeasonWindow,
): number | null {
  if (!hasNominationsBeenAnnounced(season)) return null;
  return castActingNomsCountScore(showId);
}

/**
 * Below-the-line Tony nominations count, normalized 0-100.
 *
 * Counts Tony nominations in the design/craft/score categories — the structural
 * "voters institutionally love this production" signal that's distinct from
 * the top-cat (Best Musical/Play) and from acting noms. For best-musical,
 * total noms in: Direction, Scenic, Costume, Lighting, Sound, Score (Music
 * + Lyrics), Book, Orchestrations, Choreography. For best-play: Direction,
 * Scenic, Costume, Lighting, Sound.
 *
 * Returns 0 if no data (pre-nom seasons return 0 since tony.nominatedFor is
 * empty). Categories are case-insensitive matched against awards.json.
 */
const BELOW_LINE_MUSICAL_CATEGORIES = new Set([
  'Best Direction of a Musical',
  'Best Scenic Design of a Musical',
  'Best Costume Design of a Musical',
  'Best Lighting Design of a Musical',
  'Best Sound Design of a Musical',
  'Best Original Score',
  'Best Book of a Musical',
  'Best Orchestrations',
  'Best Choreography',
]);
const BELOW_LINE_PLAY_CATEGORIES = new Set([
  'Best Direction of a Play',
  'Best Scenic Design of a Play',
  'Best Costume Design of a Play',
  'Best Lighting Design of a Play',
  'Best Sound Design of a Play',
]);

export function belowTheLineNomsScore(showId: string, categoryKey: TonyCategoryKey): number {
  const entry = getAwardsShows()[showId];
  if (!entry) return 0;
  const noms = entry.tony?.nominatedFor || [];
  const isMusical = categoryKey === 'best-musical' || categoryKey === 'best-revival-musical';
  const set = isMusical ? BELOW_LINE_MUSICAL_CATEGORIES : BELOW_LINE_PLAY_CATEGORIES;
  let count = 0;
  for (const n of noms) {
    if (set.has(n)) count++;
  }
  // Realistic ceilings: musicals cap ~7 below-line noms, plays cap ~5.
  const CEILING = isMusical ? 7 : 5;
  return Math.min(100, (count / CEILING) * 100);
}

/**
 * Empirical Tony-conversion-rate-by-precursor-sweep-count, smoothed.
 *
 * For each Tony category, compute the historical P(Tony win | precursor
 * sweep count) using 4 cells {0, 1, 2, 3} where sweep count is the number
 * of top-cat wins across Drama League / OCC / Drama Desk. Smoothed via a
 * Bayesian-style prior toward the category base rate with strength α=2.
 *
 * Per-category LOSO-window data (audit 2026-05-26):
 *   Best Musical:        sweep=3 → 75%, sweep=2 → 50%, sweep=1 → 25%, sweep=0 → 7%
 *   Best Play:           sweep=3 → 100%, sweep=2 → 75%, sweep=1 → 25%, sweep=0 → 0%
 *   Best Revival Musical: sweep=3 → 67%, sweep=2 → 33%, sweep=1 → 43%, sweep=0 → 12%
 *   Best Revival Play:   sweep=3 → 100%, sweep=2 → 50%, sweep=1 → 13%, sweep=0 → 11%
 *
 * The optional `excludeSeason` parameter removes one season from the rate
 * computation — required for LOSO-safe use inside the audit script. Production
 * code omits it so the rate uses all 11 historical seasons.
 *
 * Returns 0-100 (the rate × 100).
 */
export function precursorSweepConversionScore(
  showId: string,
  categoryKey: TonyCategoryKey,
  excludeSeason?: string,
): number {
  const catTitle = CATEGORY_KEY_TO_TITLE[categoryKey];
  const matching = TONY_TO_PRECURSOR_CATEGORY[catTitle];
  if (!matching) return 0;

  const showsMap = getAwardsShows();
  const showEntry = showsMap[showId];
  if (!showEntry) return 0;

  // Compute THIS show's sweep count.
  function sweepFor(entry: AwardsShowEntry & {
    dramadesk?: PrecursorNode; outerCriticsCircle?: PrecursorNode; dramaLeague?: PrecursorNode;
  }): number {
    let c = 0;
    if (matching.dramaLeague.some((x) => (entry.dramaLeague?.wins || []).includes(x))) c++;
    if (matching.outerCriticsCircle.some((x) => (entry.outerCriticsCircle?.wins || []).includes(x))) c++;
    if (matching.dramadesk.some((x) => (entry.dramadesk?.wins || []).includes(x))) c++;
    return c;
  }
  const showSweep = sweepFor(showEntry as AwardsShowEntry & { dramadesk?: PrecursorNode; outerCriticsCircle?: PrecursorNode; dramaLeague?: PrecursorNode });

  // Build the conversion table from historical LOSO-window nominees.
  const LOSO_SEASONS = new Set(['2013-14','2014-15','2015-16','2016-17','2017-18','2018-19','2019-20','2021-22','2022-23','2023-24','2024-25']);
  const cells: Record<number, { wins: number; total: number }> = {0:{wins:0,total:0}, 1:{wins:0,total:0}, 2:{wins:0,total:0}, 3:{wins:0,total:0}};
  let totalWins = 0, totalContests = 0;
  for (const [, data] of Object.entries(showsMap)) {
    const tonyData = data.tony;
    if (!tonyData?.season || !LOSO_SEASONS.has(tonyData.season)) continue;
    if (excludeSeason && tonyData.season === excludeSeason) continue;
    const isNominated = (tonyData.nominatedFor || []).includes(catTitle);
    if (!isNominated) continue;
    const sc = sweepFor(data as AwardsShowEntry & { dramadesk?: PrecursorNode; outerCriticsCircle?: PrecursorNode; dramaLeague?: PrecursorNode });
    const won = (tonyData.wins || []).includes(catTitle);
    cells[sc].total++;
    if (won) {
      cells[sc].wins++;
      totalWins++;
    }
    totalContests++;
  }
  const baseRate = totalContests > 0 ? totalWins / totalContests : 0.2;
  const cell = cells[showSweep];
  const alpha = 2;
  const rate = (cell.wins + alpha * baseRate) / (cell.total + alpha);
  return Math.max(0, Math.min(100, rate * 100));
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
  opts: { tier?: RecipeTier; seasonLabel?: string } = {},
): SerializedTonyShow {
  const buzz = getAudienceBuzz(show.id);
  const enoughAudience = buzz ? hasEnoughAudienceReviews(buzz) : false;
  const audScore = buzz?.combinedScore ?? null;

  const tonyAud = computeTonyAudienceGrade(show.id);
  const awards = categoryKey
    ? categoryAwardsScore(show.id, categoryKey)
    : 0;
  let composite = categoryKey
    ? tonyComposite(show.compositeScore, tonyAud, awards, categoryKey, opts.tier ?? 1)
    : legacyBlendedScore(show.compositeScore, enoughAudience ? audScore : null);

  // Apply Best Musical structural feasibility filter (no director nom / jukebox).
  // Multiplicative penalty drops blendedScore for shows that historically have
  // ~0% chance of winning. See bestMusicalFeasibilityFactor() for the rule and
  // historical justification.
  if (composite != null && categoryKey && opts.seasonLabel) {
    const factor = bestMusicalFeasibilityFactor(
      show.id,
      show.tags ?? [],
      categoryKey,
      opts.seasonLabel,
    );
    composite = composite * factor;
  }

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
    tonyCategoryKey: categoryKey ?? null,
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
      .map(s => serializeShow(s, cat.key, { tier: effectiveTier, seasonLabel: options?.season?.label }))
      .sort((a, b) => (b.blendedScore ?? -Infinity) - (a.blendedScore ?? -Infinity));

    // In nomineesOnly mode, all nominees should be scored (they've already opened),
    // so upcoming is empty. Otherwise, normal behavior.
    const upcoming = nomineeMap
      ? []
      : matching
          .filter(s => s.status === 'previews' || s.status === 'upcoming' || (s.criticScore?.reviewCount || 0) < 5)
          .sort((a, b) => (a.openingDate || '').localeCompare(b.openingDate || ''))
          .map(s => serializeShow(s, cat.key, { tier: effectiveTier, seasonLabel: options?.season?.label }));

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

// --- Headline accuracy (single source of truth) ---

export interface TonyTrackRecord {
  /** Correct rank-1 picks across all seasons + categories with Tony results. */
  hits: number;
  /** Total category cells across all seasons with Tony results. */
  cells: number;
  /** hits / cells × 100, rounded to one decimal. Matches the season page headline. */
  pct: number;
  /** Number of seasons that have Tony results (denominator for "X seasons"). */
  seasons: number;
}

/**
 * Computes the same accuracy headline shown on /tony-awards/predictions/[season]
 * (lines 86-96). Use this anywhere off-page (homepage promo, social cards, etc.)
 * so the headline stays in sync with the live predictions page.
 */
export function getTonyTrackRecord(allShows: ComputedShow[]): TonyTrackRecord {
  const allSeasons = getAllPredictionSeasons();
  const summaries = allSeasons.map(s => getSeasonSummary(allShows, s));
  let hits = 0;
  let cells = 0;
  let seasons = 0;
  for (const sum of summaries) {
    if (!sum.hasTonyResults) continue;
    seasons++;
    for (const h of sum.categoryHighlights) {
      if (!h.winnerTitle) continue;
      cells++;
      if (h.topShowTitle && h.winnerTitle === h.topShowTitle) hits++;
    }
  }
  const pct = cells > 0 ? Math.round((hits / cells) * 1000) / 10 : 0;
  return { hits, cells, pct, seasons };
}

// --- LOSO stats (auto-written by scripts/audit-tony-loso.ts) ---

export interface TonyLosoStats {
  /** ISO date the stats were generated. */
  asOf: string;
  /** Total leave-one-season-out match counts. */
  totalLoso: { hits: number; total: number; pct: number };
  /** In-sample backtest counts using the same shipped recipes. */
  totalInSample: { hits: number; total: number; pct: number };
  /** Per-category breakdown. */
  perCategory: Array<{
    key: string;
    config: { objective: string; shrinkage: number; ensembleK: number };
    inSample: { hits: number; total: number; pct: number };
    loso: { hits: number; total: number; pct: number };
  }>;
}

/**
 * Returns the LOSO statistics that match the currently-shipped TONY_RECIPES.
 * Regenerated by `npx tsx scripts/audit-tony-loso.ts` (writes
 * data/tony-loso-stats.json with the SHIPPED_PROCEDURE per-category config).
 * Any UI surface that displays out-of-sample model accuracy should read from
 * here rather than hardcoding a number — recipe changes propagate to the
 * disclosure copy automatically.
 */
export function getTonyLosoStats(): TonyLosoStats {
  return tonyLosoStatsData as unknown as TonyLosoStats;
}

// --- GoldDerby head-to-head comparison ---

export interface GoldDerbyComparison {
  asOf: string;
  sample: { races: number; cycles: number };
  ours: { hits: number; total: number; pct: number };
  goldDerby: { hits: number; total: number; pct: number };
  weBeatThemCount: number;
  theyBeatUsCount: number;
  bothRight: number;
  bothWrong: number;
  perCategory: Array<{ key: string; label: string; ours: number; theirs: number; total: number }>;
  weHitTheyMissed: Array<{ cycle: string; category: string; ourPick: string; gdPick: string; winner: string }>;
  theyHitWeMissed: Array<{ cycle: string; category: string; ourPick: string; gdPick: string; winner: string }>;
}

const CATEGORY_LABEL_MAP: Record<string, string> = {
  'best-musical': 'Best Musical',
  'best-play': 'Best Play',
  'best-revival-musical': 'Best Revival of a Musical',
  'best-revival-play': 'Best Revival of a Play',
};

/**
 * Returns the head-to-head comparison between the Broadway Scorecard model
 * and GoldDerby's pundit-consensus predictions across all historical Tony
 * cycles for which both methods produced picks. Data sourced from
 * data/analysis/gd-vs-broadwayscore.json, regenerated by
 * `npx tsx scripts/compare-gd-vs-broadwayscore.ts` whenever the model
 * recipes change. This is the comparison we cite on the predictions page
 * as the external benchmark — "is the LOSO number just backtest-luck or
 * does the model actually beat a panel of theatre experts making real-time
 * pre-ceremony predictions?"
 */
// Empty-shape fallback used when the artifact is missing fields. The
// predictions page calls `getGoldDerbyComparison()` at render time; if the
// JSON is partial or malformed, returning a safe zero-shape lets the page
// continue rendering with the section showing all zeros rather than throwing
// at runtime. Caller can also check `total === 0` to hide the section
// entirely if desired.
const EMPTY_GD_COMPARISON: GoldDerbyComparison = {
  asOf: '',
  sample: { races: 0, cycles: 0 },
  ours: { hits: 0, total: 0, pct: 0 },
  goldDerby: { hits: 0, total: 0, pct: 0 },
  weBeatThemCount: 0,
  theyBeatUsCount: 0,
  bothRight: 0,
  bothWrong: 0,
  perCategory: [],
  weHitTheyMissed: [],
  theyHitWeMissed: [],
};

export function getGoldDerbyComparison(): GoldDerbyComparison {
  const raw = gdComparisonData as unknown as Partial<{
    _meta: Partial<{
      generatedAt: string;
      sample: Partial<{ races: number; cycles: number }>;
      ourSummary: Partial<{ hits: number; total: number; pct: number }>;
      gdSummary: Partial<{ hits: number; total: number; pct: number }>;
      weBeatThemCount: number;
      theyBeatUsCount: number;
      bothRight: number;
      bothWrong: number;
    }>;
    catStats: Record<string, Partial<{ ours: number; theirs: number; total: number }>>;
    weHitTheyMissed: Array<Partial<{ cycle: string; category: string; ourPickTitle: string; gdPickTitle: string; winnerTitle: string }>>;
    theyHitWeMissed: Array<Partial<{ cycle: string; category: string; ourPickTitle: string; gdPickTitle: string; winnerTitle: string }>>;
  }>;

  // Shape-check the artifact. If any of the top-level structural fields
  // are missing, fall back to the empty shape so the page render survives.
  // This protects against JSON corruption, partial generator output, or
  // a future schema change in compare-gd-vs-broadwayscore.ts.
  if (!raw || !raw._meta || !raw._meta.sample || !raw._meta.ourSummary || !raw._meta.gdSummary) {
    return EMPTY_GD_COMPARISON;
  }

  const round1 = (n: number | undefined) => (typeof n === 'number' ? Math.round(n * 1000) / 10 : 0);
  const num = (n: number | undefined) => (typeof n === 'number' ? n : 0);

  return {
    asOf: raw._meta.generatedAt ?? '',
    sample: { races: num(raw._meta.sample.races), cycles: num(raw._meta.sample.cycles) },
    ours: {
      hits: num(raw._meta.ourSummary.hits),
      total: num(raw._meta.ourSummary.total),
      pct: round1(raw._meta.ourSummary.pct),
    },
    goldDerby: {
      hits: num(raw._meta.gdSummary.hits),
      total: num(raw._meta.gdSummary.total),
      pct: round1(raw._meta.gdSummary.pct),
    },
    weBeatThemCount: num(raw._meta.weBeatThemCount),
    theyBeatUsCount: num(raw._meta.theyBeatUsCount),
    bothRight: num(raw._meta.bothRight),
    bothWrong: num(raw._meta.bothWrong),
    perCategory: Object.entries(raw.catStats ?? {}).map(([key, stats]) => ({
      key,
      label: CATEGORY_LABEL_MAP[key] ?? key,
      ours: num(stats?.ours),
      theirs: num(stats?.theirs),
      total: num(stats?.total),
    })),
    weHitTheyMissed: (raw.weHitTheyMissed ?? []).map(r => ({
      cycle: r?.cycle ?? '',
      category: r?.category ?? '',
      ourPick: r?.ourPickTitle ?? '',
      gdPick: r?.gdPickTitle ?? '',
      winner: r?.winnerTitle ?? '',
    })),
    theyHitWeMissed: (raw.theyHitWeMissed ?? []).map(r => ({
      cycle: r?.cycle ?? '',
      category: r?.category ?? '',
      ourPick: r?.ourPickTitle ?? '',
      gdPick: r?.gdPickTitle ?? '',
      winner: r?.winnerTitle ?? '',
    })),
  };
}

// --- Promo sunset ---

/**
 * Whether to surface the homepage Tony-predictions promo. Active until
 * (current season's ceremonyDate + sunsetDays). After that the promo hides
 * itself — no manual takedown needed. Vercel cron rebuilds every 5 min so the
 * transition lands within minutes of the threshold. Falls back to "active"
 * if the ceremony date is unknown for the current season.
 */
export function isTonyPromoActive(now: Date = new Date(), sunsetDays = 2): boolean {
  const current = getTonySeasonWindow();
  const record = tonySeasonForCeremonyYear(current.ceremonyYear);
  const ceremonyDate = record?.ceremonyDate;
  if (!ceremonyDate) return true;
  const sunsetMs = new Date(`${ceremonyDate}T23:59:59Z`).getTime() + sunsetDays * 24 * 60 * 60 * 1000;
  return now.getTime() <= sunsetMs;
}

/**
 * Beat the Critics promo activity gate. BTC entries close per official rules
 * at 11:59 PM Eastern Time the night BEFORE the ceremony (≈ ceremonyDate
 * 03:59 UTC). Returns true only while entries are still being accepted.
 * Falls back to "active" if ceremony date is unknown.
 */
export function isBtcPromoActive(now: Date = new Date()): boolean {
  const current = getTonySeasonWindow();
  const record = tonySeasonForCeremonyYear(current.ceremonyYear);
  const ceremonyDate = record?.ceremonyDate;
  if (!ceremonyDate) return true;
  // 11:59 PM Eastern (EDT = UTC-4 in June) = ceremony day 03:59 UTC
  const deadlineMs = new Date(`${ceremonyDate}T03:59:59Z`).getTime();
  return now.getTime() <= deadlineMs;
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
