/**
 * Leave-one-season-out (LOSO) cross-validation of the Tony predictions model.
 *
 * For each of the four winner categories, and for each historical season:
 *   1. Hold out that season as the test fold.
 *   2. Grid-search the 3 recipe weights {critic, audience, awards} (step 0.05,
 *      summing to 1.0) on the OTHER 10 seasons. Pick the weights that maximise
 *      training accuracy. Tie-break by lowest max-weight (production preference
 *      for balanced recipes).
 *   3. Apply the trained recipe — PLUS the unchanged structural feasibility
 *      filter — to the held-out season's nominees. Check whether the #1 score
 *      matches the actual Tony winner.
 *
 * Aggregate hits / totals per category and overall. The headline LOSO number is
 * the honest out-of-sample analogue of the in-sample 90.7% currently displayed
 * on /tony-awards/predictions.
 *
 * Run:
 *   npx tsx scripts/audit-tony-loso.ts
 *   npx tsx scripts/audit-tony-loso.ts --step=0.05
 */

import fs from 'fs';
import path from 'path';
import { getBroadwayShows } from '../src/lib/data-core';
import {
  getAllPredictionSeasons,
  getEligibleShowsForPastSeason,
  getEligibleShows,
  getTonySeasonWindow,
  groupIntoCategories,
  getWinnersForSeason,
  computeTonyAudienceGrade,
  categoryAwardsScore,
  bestMusicalFeasibilityFactor,
  precursorSweepConversionScore,
  castActingNomsScore,
  belowTheLineNomsScore,
  topCatPrecursorScore,
  type TonyCategoryKey,
} from '../src/lib/data-tony-predictions';

const CATEGORY_KEYS: TonyCategoryKey[] = [
  'best-musical',
  'best-play',
  'best-revival-musical',
  'best-revival-play',
];

const CATEGORY_KEY_TO_TITLE: Record<TonyCategoryKey, string> = {
  'best-musical': 'Best Musical',
  'best-play': 'Best Play',
  'best-revival-musical': 'Best Revival of a Musical',
  'best-revival-play': 'Best Revival of a Play',
};

function argVal(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a?.split('=')[1];
}
const STEP = argVal('step') ? parseFloat(argVal('step')!) : 0.05;
const STEP_INT = Math.round(STEP * 100);
const OBJECTIVE: 'accuracy' | 'logloss' = (argVal('objective') as 'accuracy' | 'logloss') ?? 'accuracy';
const T_SOFTMAX = argVal('T') ? parseFloat(argVal('T')!) : 7;
const SHRINKAGE = argVal('shrinkage') ? parseFloat(argVal('shrinkage')!) : 0;
const ENSEMBLE_K = argVal('ensemble') ? parseInt(argVal('ensemble')!) : 1;
const PERMUTATIONS = argVal('permutations') ? parseInt(argVal('permutations')!) : 0;
const SWEEP = process.argv.includes('--sweep');
const AWARDS_SWEEP = process.argv.includes('--awards-sweep');

// --awards-cfg=baseline:sweepConv:castNoms — e.g. "1:0:0" (shipped default),
// "0:1:0" (pure sweep-conversion), "0.5:0.5:0" (50/50 blend), etc.
function parseAwardsCfg(): AwardsConfig | undefined {
  const a = argVal('awards-cfg');
  if (!a) return undefined;
  const [b, s, c] = a.split(':').map(parseFloat);
  return { baseline: b || 0, sweepConv: s || 0, castNoms: c || 0 };
}

type Recipe = { critic: number; audience: number; awards: number };

// Mirror of src/lib/data-tony-predictions.ts TONY_RECIPES (Tier 1). Update
// here when the shipped recipes change — used for the in-sample diagnostic.
const SHIPPED_RECIPES: Record<TonyCategoryKey, Recipe> = {
  'best-musical': { critic: 0.45, audience: 0.45, awards: 0.10 },
  'best-play': { critic: 0, audience: 0, awards: 1.0 },
  'best-revival-musical': { critic: 0.00, audience: 0.95, awards: 0.05 },
  'best-revival-play': { critic: 0.2, audience: 0.6, awards: 0.2 },
};

// The shipped FITTING PROCEDURE per category — i.e. which objective each
// shipped recipe was derived from. This is what the audit's default LOSO
// reports. Without it, a naive default run uses accuracy globally and
// produces 36/43 = 83.7% — which contradicts the 88.4% figure displayed on
// /tony-awards/predictions. The discrepancy is real (per-cat best-revival-
// musical uses log-loss) and the default should mirror it.
//
//   best-musical:         accuracy (4-dim grid search, see TONY_RECIPES L81)
//   best-play:            accuracy (categoryAwardsScore combines topCat+broad)
//   best-revival-musical: log-loss (2026-05-25, perfects LOSO 8/10 → 10/10)
//   best-revival-play:    accuracy (categoryAwardsScore=blindedSiteLogScore)
const SHIPPED_PROCEDURE: Record<TonyCategoryKey, Config> = {
  'best-musical':         { objective: 'accuracy', shrinkage: 0, ensembleK: 1 },
  'best-play':            { objective: 'accuracy', shrinkage: 0, ensembleK: 1 },
  'best-revival-musical': { objective: 'logloss',  shrinkage: 0, ensembleK: 1 },
  'best-revival-play':    { objective: 'accuracy', shrinkage: 0, ensembleK: 1 },
};

// Shrinkage target: uniform (1/3, 1/3, 1/3) — maximum-entropy prior. Chosen
// over "shipped recipe" because the shipped recipe was itself tuned on all 11
// seasons; shrinking toward it would leak in-sample fit into LOSO eval.
const UNIFORM_RECIPE: Recipe = { critic: 1/3, audience: 1/3, awards: 1/3 };

interface NomEntry {
  showId: string;
  tags: string[];
  critic: number | null;
  audience: number | null;
  awards: number;          // baseline category-aware awards score (production formula)
  castNomsScore: number;   // 0-100 cast acting Tony noms (all historical seasons have noms data)
  belowLineScore: number;  // 0-100 below-the-line Tony noms (design/craft/score/etc.)
  // sweepConvScore is computed per-fold (depends on held-season exclusion) and
  // is attached at fold time, not at fixture-load time. Stored as optional so
  // the same NomEntry can be reused across folds.
  sweepConvScore?: number;
}

// Sub-weights of the awards-term blend. Defaults to the current shipped
// behavior (baseline only). Audit experiments perturb these.
interface AwardsConfig {
  baseline: number;   // current categoryAwardsScore (existing behavior)
  sweepConv: number;  // precursorSweepConversionScore (LOSO-safe per fold)
  castNoms: number;   // castActingNomsScore (count of acting Tony noms, normalized)
  belowLine: number;  // belowTheLineNomsScore (design/craft/score Tony noms, normalized)
}

const SHIPPED_AWARDS_CONFIG: AwardsConfig = { baseline: 1, sweepConv: 0, castNoms: 0, belowLine: 0 };

function blendAwards(n: NomEntry, cfg: AwardsConfig): number {
  const total = cfg.baseline + cfg.sweepConv + cfg.castNoms + cfg.belowLine;
  if (total === 0) return 0;
  const baseline = (cfg.baseline / total) * n.awards;
  const sweep = (cfg.sweepConv / total) * (n.sweepConvScore ?? 0);
  const cast = (cfg.castNoms / total) * n.castNomsScore;
  const below = (cfg.belowLine / total) * n.belowLineScore;
  return baseline + sweep + cast + below;
}

interface SeasonFixture {
  label: string;
  winnerShowId: string;
  nominees: NomEntry[];
}

function loadFixtures(catKey: TonyCategoryKey): SeasonFixture[] {
  const allShows = getBroadwayShows();
  const seasons = getAllPredictionSeasons();
  const catTitle = CATEGORY_KEY_TO_TITLE[catKey];
  const fixtures: SeasonFixture[] = [];

  for (const season of seasons) {
    const eligible = getEligibleShowsForPastSeason(allShows, season);
    const categories = groupIntoCategories(eligible, { nomineesOnly: true, season });
    const cat = categories.find((c) => c.key === catKey);
    if (!cat || cat.shows.length === 0) continue;

    const winners = getWinnersForSeason(season);
    const winnerShowId = winners.get(catTitle);
    if (!winnerShowId) continue;

    const nominees: NomEntry[] = [];
    for (const s of cat.shows) {
      const show = eligible.find((e) => e.slug === s.slug);
      if (!show) continue;
      const cast = castActingNomsScore(show.id, season);
      nominees.push({
        showId: show.id,
        tags: show.tags ?? [],
        critic: show.compositeScore,
        audience: computeTonyAudienceGrade(show.id),
        awards: categoryAwardsScore(show.id, catKey),
        castNomsScore: cast ?? 0,
        belowLineScore: belowTheLineNomsScore(show.id, catKey),
      });
    }
    // Only fold seasons where the winner is actually in the nominee fixture
    // (i.e., we have prediction inputs for them). Otherwise LOSO is meaningless.
    if (!nominees.some((n) => n.showId === winnerShowId)) continue;
    fixtures.push({ label: season.label, winnerShowId, nominees });
  }
  return fixtures;
}

// Per-fold leakage protection: stamp each nominee with the precursor sweep
// conversion score that EXCLUDES the held-out season. Call this inside the
// LOSO fold loop before training/predicting. Reset by calling with
// `excludeSeasonLabel=null` to clear the cache between folds.
function stampSweepConvScores(
  fixtures: SeasonFixture[],
  catKey: TonyCategoryKey,
  excludeSeasonLabel: string | null,
): void {
  // Translate audit's long-form season label (2025-2026) to awards.json's
  // short form (2025-26) — that's what precursorSweepConversionScore expects.
  const awardsSeasonLabel = excludeSeasonLabel
    ? (() => {
        const [a, b] = excludeSeasonLabel.split('-');
        return a && b ? `${a}-${b.slice(-2)}` : excludeSeasonLabel;
      })()
    : undefined;
  for (const f of fixtures) {
    for (const nom of f.nominees) {
      if (excludeSeasonLabel === null) {
        delete nom.sweepConvScore;
      } else {
        nom.sweepConvScore = precursorSweepConversionScore(nom.showId, catKey, awardsSeasonLabel);
      }
    }
  }
}

function compositeFor(n: NomEntry, w: Recipe, awardsCfg: AwardsConfig): number | null {
  const awardsValue = blendAwards(n, awardsCfg);
  const components: Array<{ weight: number; value: number }> = [];
  if (w.critic > 0 && n.critic != null) components.push({ weight: w.critic, value: n.critic });
  if (w.audience > 0 && n.audience != null) components.push({ weight: w.audience, value: n.audience });
  if (w.awards > 0 && awardsValue > 0) components.push({ weight: w.awards, value: awardsValue });
  if (components.length === 0) return null;
  const total = components.reduce((s, c) => s + c.weight, 0);
  return components.reduce((s, c) => s + (c.weight / total) * c.value, 0);
}

// Score a nominee against ONE OR MORE recipes; the prediction averages the
// per-recipe weighted-average composites. Preserves magnitude semantics
// (no fake Borda rescale) — averaging real composites stays in 0..100.
function scoreFor(n: NomEntry, recipes: Recipe[], catKey: TonyCategoryKey, seasonLabel: string, awardsCfg: AwardsConfig): number | null {
  const factor = bestMusicalFeasibilityFactor(n.showId, n.tags, catKey, seasonLabel);
  const scores = recipes.map((r) => compositeFor(n, r, awardsCfg)).filter((s): s is number => s != null);
  if (scores.length === 0) return null;
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  return mean * factor;
}

function predictWinner(fixture: SeasonFixture, catKey: TonyCategoryKey, recipes: Recipe[], awardsCfg: AwardsConfig): string | null {
  const ranked = fixture.nominees
    .map((n) => ({ showId: n.showId, score: scoreFor(n, recipes, catKey, fixture.label, awardsCfg) }))
    .filter((r) => r.score != null)
    .sort((a, b) => (b.score! - a.score!));
  return ranked[0]?.showId ?? null;
}

function trainingAccuracy(train: SeasonFixture[], catKey: TonyCategoryKey, recipes: Recipe[], awardsCfg: AwardsConfig): { hits: number; total: number } {
  let hits = 0, total = 0;
  for (const f of train) {
    const pick = predictWinner(f, catKey, recipes, awardsCfg);
    if (pick == null) continue;
    total++;
    if (pick === f.winnerShowId) hits++;
  }
  return { hits, total };
}

// Mean cross-entropy of the winner under softmax(scores / T) across training
// seasons. Lower is better. Uses the same temperature T=7 as the production
// "Our Pick %" softmax in src/app/tony-awards/predictions/page.tsx.
function trainingLogLoss(train: SeasonFixture[], catKey: TonyCategoryKey, recipes: Recipe[], T: number, awardsCfg: AwardsConfig): number {
  let total = 0, n = 0;
  for (const f of train) {
    const winnerIdx = f.nominees.findIndex((nm) => nm.showId === f.winnerShowId);
    if (winnerIdx < 0) continue;
    const scores = f.nominees.map((nm) => scoreFor(nm, recipes, catKey, f.label, awardsCfg));
    if (scores[winnerIdx] == null) continue;
    const valid = scores.map((s) => (s == null ? -Infinity : s));
    const maxS = Math.max(...valid.filter((s) => isFinite(s)));
    const exps = valid.map((s) => (isFinite(s) ? Math.exp((s - maxS) / T) : 0));
    const sum = exps.reduce((a, b) => a + b, 0);
    if (sum <= 0) continue;
    const p = exps[winnerIdx] / sum;
    total += -Math.log(Math.max(p, 1e-12));
    n++;
  }
  return n ? total / n : Infinity;
}

function shrink(w: Recipe, lambda: number): Recipe {
  if (lambda <= 0) return w;
  const cr = (1 - lambda) * w.critic + lambda * UNIFORM_RECIPE.critic;
  const au = (1 - lambda) * w.audience + lambda * UNIFORM_RECIPE.audience;
  const aw = (1 - lambda) * w.awards + lambda * UNIFORM_RECIPE.awards;
  const s = cr + au + aw;
  return { critic: cr / s, audience: au / s, awards: aw / s };
}

interface ScoredRecipe { w: Recipe; score: number; maxW: number }

// Grid-search all simplex recipes; return ordered by quality (best-first).
// `score` is "higher is better" — for log-loss objective we negate so the same
// sort works.
function gridSearch(train: SeasonFixture[], catKey: TonyCategoryKey, objective: 'accuracy' | 'logloss', awardsCfg: AwardsConfig): ScoredRecipe[] {
  const out: ScoredRecipe[] = [];
  for (let cr = 0; cr <= 100; cr += STEP_INT) {
    for (let au = 0; au <= 100 - cr; au += STEP_INT) {
      const aw = 100 - cr - au;
      const w: Recipe = { critic: cr / 100, audience: au / 100, awards: aw / 100 };
      let score: number;
      if (objective === 'logloss') {
        const ll = trainingLogLoss(train, catKey, [w], T_SOFTMAX, awardsCfg);
        score = -ll;  // higher is better
      } else {
        const { hits, total } = trainingAccuracy(train, catKey, [w], awardsCfg);
        score = total ? hits / total : 0;
      }
      const maxW = Math.max(w.critic, w.audience, w.awards);
      out.push({ w, score, maxW });
    }
  }
  // Sort: best score first; on ties prefer lower max weight (balanced).
  out.sort((a, b) => (b.score - a.score) || (a.maxW - b.maxW));
  return out;
}

function trainRecipes(
  train: SeasonFixture[],
  catKey: TonyCategoryKey,
  config: { objective: 'accuracy' | 'logloss'; shrinkage: number; ensembleK: number },
  awardsCfg: AwardsConfig,
): Recipe[] {
  const ranked = gridSearch(train, catKey, config.objective, awardsCfg);
  const k = Math.max(1, config.ensembleK);
  return ranked.slice(0, k).map((r) => shrink(r.w, config.shrinkage));
}

interface FoldResult {
  heldSeason: string;
  trainedRecipes: Recipe[];
  predictedShowId: string | null;
  actualShowId: string;
  hit: boolean;
}

interface CategoryResult {
  catKey: TonyCategoryKey;
  inSampleAcc: { hits: number; total: number };
  losoAcc: { hits: number; total: number };
  folds: FoldResult[];
}

function losoForCategory(
  catKey: TonyCategoryKey,
  config: { objective: 'accuracy' | 'logloss'; shrinkage: number; ensembleK: number; awardsCfg?: AwardsConfig },
  fixturesOverride?: SeasonFixture[],
): CategoryResult {
  const fixtures = fixturesOverride ?? loadFixtures(catKey);
  const awardsCfg = config.awardsCfg ?? SHIPPED_AWARDS_CONFIG;
  // In-sample: shipped recipe applied to every season. Stamp all-seasons
  // sweepConvScore (no exclusion) for in-sample diagnostic only.
  stampSweepConvScores(fixtures, catKey, '__ALL__');  // marker; we want all-seasons rate
  // Convention: empty string excludes nothing; use undefined-like behavior.
  // The function uses excludeSeasonLabel for the API; for "no exclusion" we
  // need a different path. Simpler: pre-stamp using each nominee's own season
  // — i.e. exclude self. Same as production behavior would be using all 11.
  // Use null marker to clear, then re-stamp with no exclusion.
  for (const f of fixtures) {
    for (const nom of f.nominees) {
      nom.sweepConvScore = precursorSweepConversionScore(nom.showId, catKey);
    }
  }
  const shipped = SHIPPED_RECIPES[catKey];
  const inSample = trainingAccuracy(fixtures, catKey, [shipped], awardsCfg);

  const folds: FoldResult[] = [];
  let losoHits = 0;
  for (let i = 0; i < fixtures.length; i++) {
    const held = fixtures[i];
    const train = fixtures.filter((_, j) => j !== i);
    // Stamp the held-season-excluded sweepConvScore on all fixtures for this fold.
    stampSweepConvScores(fixtures, catKey, held.label);
    const trainedRecipes = trainRecipes(train, catKey, config, awardsCfg);
    const pick = predictWinner(held, catKey, trainedRecipes, awardsCfg);
    const hit = pick === held.winnerShowId;
    if (hit) losoHits++;
    folds.push({
      heldSeason: held.label,
      trainedRecipes,
      predictedShowId: pick,
      actualShowId: held.winnerShowId,
      hit,
    });
  }
  return {
    catKey,
    inSampleAcc: inSample,
    losoAcc: { hits: losoHits, total: fixtures.length },
    folds,
  };
}

function fmtPct(hits: number, total: number): string {
  if (!total) return ' n/a ';
  return `${((hits / total) * 100).toFixed(1)}%`.padStart(6);
}

function fmtWeights(w: { critic: number; audience: number; awards: number }): string {
  return `${w.critic.toFixed(2)}/${w.audience.toFixed(2)}/${w.awards.toFixed(2)}`;
}

type Config = { objective: 'accuracy' | 'logloss'; shrinkage: number; ensembleK: number; awardsCfg?: AwardsConfig };

function runLOSO(config: Config, verbose = false): {
  summaries: CategoryResult[];
  totalInSample: { hits: number; total: number };
  totalLoso: { hits: number; total: number };
} {
  const summaries: CategoryResult[] = [];
  let inH = 0, inT = 0, lH = 0, lT = 0;
  for (const catKey of CATEGORY_KEYS) {
    const r = losoForCategory(catKey, config);
    summaries.push(r);
    inH += r.inSampleAcc.hits;
    inT += r.inSampleAcc.total;
    lH += r.losoAcc.hits;
    lT += r.losoAcc.total;
    if (verbose) {
      console.log(`\n--- ${catKey} (shipped recipe ${fmtWeights(SHIPPED_RECIPES[catKey])}) ---`);
      console.log(`  In-sample (shipped):   ${r.inSampleAcc.hits}/${r.inSampleAcc.total}  (${fmtPct(r.inSampleAcc.hits, r.inSampleAcc.total)})`);
      console.log(`  LOSO (held-out):       ${r.losoAcc.hits}/${r.losoAcc.total}  (${fmtPct(r.losoAcc.hits, r.losoAcc.total)})`);
      console.log(`  Per-fold:`);
      for (const f of r.folds) {
        const mark = f.hit ? '✓' : '✗';
        const wstr = f.trainedRecipes.length === 1
          ? fmtWeights(f.trainedRecipes[0])
          : `${f.trainedRecipes.length} recipes [top=${fmtWeights(f.trainedRecipes[0])}]`;
        console.log(`    ${mark} ${f.heldSeason}  trained ${wstr}  picked=${f.predictedShowId ?? '(none)'}  actual=${f.actualShowId}`);
      }
    }
  }
  return {
    summaries,
    totalInSample: { hits: inH, total: inT },
    totalLoso: { hits: lH, total: lT },
  };
}

function configLabel(c: Config): string {
  return `obj=${c.objective.padEnd(8)} λ=${c.shrinkage.toFixed(2)} k=${String(c.ensembleK).padStart(2)}`;
}

function runSweep(): void {
  const KS = [1, 3, 5];
  const LAMBDAS = [0, 0.25, 0.5];
  const OBJS: Array<'accuracy' | 'logloss'> = ['accuracy', 'logloss'];

  console.log('========================================================');
  console.log('Sweep — 18 configs');
  console.log('========================================================');
  console.log(`Grid step: ${STEP}  |  T_softmax (log-loss): ${T_SOFTMAX}`);
  console.log();
  console.log('config'.padEnd(34) + '  total LOSO   per-category (m/p/rm/rp)');
  console.log('-'.repeat(82));

  const results: Array<{ config: Config; total: { hits: number; total: number }; perCat: Map<TonyCategoryKey, { hits: number; total: number }> }> = [];

  for (const objective of OBJS) {
    for (const shrinkage of LAMBDAS) {
      for (const ensembleK of KS) {
        const config: Config = { objective, shrinkage, ensembleK };
        const r = runLOSO(config, false);
        const perCat = new Map<TonyCategoryKey, { hits: number; total: number }>();
        for (const s of r.summaries) perCat.set(s.catKey, s.losoAcc);
        results.push({ config, total: r.totalLoso, perCat });
        const m = perCat.get('best-musical')!;
        const p = perCat.get('best-play')!;
        const rm = perCat.get('best-revival-musical')!;
        const rp = perCat.get('best-revival-play')!;
        const cat = `${m.hits}/${m.total} ${p.hits}/${p.total} ${rm.hits}/${rm.total} ${rp.hits}/${rp.total}`;
        console.log(`${configLabel(config).padEnd(34)}  ${r.totalLoso.hits}/${r.totalLoso.total}  ${fmtPct(r.totalLoso.hits, r.totalLoso.total)}    ${cat}`);
      }
    }
  }

  results.sort((a, b) => b.total.hits - a.total.hits);
  console.log();
  console.log('Top 5 configs by LOSO:');
  for (const r of results.slice(0, 5)) {
    console.log(`  ${configLabel(r.config).padEnd(34)}  ${r.total.hits}/${r.total.total}  ${fmtPct(r.total.hits, r.total.total)}`);
  }
  console.log();
  console.log(`Baseline LOSO (shipped recipes refit per fold, accuracy, k=1, λ=0): 36/43 = 83.7%`);
}

// Permutation null: randomly relabel the winner within each category-contest
// (drawn uniformly from that contest's nominees) and re-run LOSO under the
// SAME config. Repeat P times; the observed LOSO's percentile tells us how
// often chance alone produces a number this good.
function runPermutationNull(config: Config, P: number): void {
  console.log('========================================================');
  console.log(`Permutation null — ${P} runs at config ${configLabel(config)}`);
  console.log('========================================================');

  // Observed
  const observed = runLOSO(config, false).totalLoso;
  console.log(`Observed LOSO: ${observed.hits}/${observed.total}  =  ${fmtPct(observed.hits, observed.total)}`);

  // Pre-load fixtures once
  const fixturesByCat = new Map<TonyCategoryKey, SeasonFixture[]>();
  for (const c of CATEGORY_KEYS) fixturesByCat.set(c, loadFixtures(c));

  const draws: number[] = [];
  for (let p = 0; p < P; p++) {
    let pH = 0, pT = 0;
    for (const catKey of CATEGORY_KEYS) {
      const orig = fixturesByCat.get(catKey)!;
      const shuffled: SeasonFixture[] = orig.map((f) => {
        const idx = Math.floor(Math.random() * f.nominees.length);
        return { ...f, winnerShowId: f.nominees[idx].showId };
      });
      const r = losoForCategory(catKey, config, shuffled);
      pH += r.losoAcc.hits;
      pT += r.losoAcc.total;
    }
    draws.push(pH);
    if ((p + 1) % Math.max(1, Math.floor(P / 10)) === 0) {
      process.stderr.write(`  ${p + 1}/${P}\r`);
    }
  }
  process.stderr.write('\n');

  draws.sort((a, b) => a - b);
  const ge = draws.filter((d) => d >= observed.hits).length;
  const pValue = ge / P;
  const median = draws[Math.floor(P / 2)];
  const p90 = draws[Math.floor(P * 0.9)];
  const p95 = draws[Math.floor(P * 0.95)];
  console.log(`Null distribution (hits/${observed.total}):`);
  console.log(`  median: ${median}  p90: ${p90}  p95: ${p95}`);
  console.log(`  draws ≥ observed (${observed.hits}): ${ge}/${P}  →  p = ${pValue.toFixed(3)}`);
}

// Parse --per-cat=<best-musical:acc:0:3,best-play:acc:0:1,...>
// Format per cat: catKey:obj:lambda:k  (obj is "acc" or "ll")
function parsePerCat(): Map<TonyCategoryKey, Config> | null {
  const arg = argVal('per-cat');
  if (!arg) return null;
  const out = new Map<TonyCategoryKey, Config>();
  for (const part of arg.split(',')) {
    const [catKey, obj, lam, k] = part.split(':');
    out.set(catKey as TonyCategoryKey, {
      objective: obj === 'll' ? 'logloss' : 'accuracy',
      shrinkage: parseFloat(lam),
      ensembleK: parseInt(k),
    });
  }
  return out;
}

function runPerCatLOSO(perCat: Map<TonyCategoryKey, Config>, opts: { write?: boolean } = {}): void {
  console.log('========================================================');
  console.log('Per-category LOSO with mixed configs');
  console.log('========================================================');
  let inH = 0, inT = 0, lH = 0, lT = 0;
  const perCategoryStats: Array<{
    key: TonyCategoryKey;
    config: { objective: string; shrinkage: number; ensembleK: number };
    inSample: { hits: number; total: number; pct: number };
    loso: { hits: number; total: number; pct: number };
  }> = [];
  for (const catKey of CATEGORY_KEYS) {
    const config = perCat.get(catKey);
    if (!config) {
      console.log(`  ${catKey.padEnd(22)}  SKIP (no config provided)`);
      continue;
    }
    const r = losoForCategory(catKey, config);
    inH += r.inSampleAcc.hits; inT += r.inSampleAcc.total;
    lH += r.losoAcc.hits;       lT += r.losoAcc.total;
    perCategoryStats.push({
      key: catKey,
      config: { objective: config.objective, shrinkage: config.shrinkage, ensembleK: config.ensembleK },
      inSample: { hits: r.inSampleAcc.hits, total: r.inSampleAcc.total, pct: r.inSampleAcc.total ? Math.round((r.inSampleAcc.hits / r.inSampleAcc.total) * 1000) / 10 : 0 },
      loso: { hits: r.losoAcc.hits, total: r.losoAcc.total, pct: r.losoAcc.total ? Math.round((r.losoAcc.hits / r.losoAcc.total) * 1000) / 10 : 0 },
    });
    console.log(`  ${catKey.padEnd(22)}  ${configLabel(config).padEnd(34)}  in=${fmtPct(r.inSampleAcc.hits, r.inSampleAcc.total)}  loso=${fmtPct(r.losoAcc.hits, r.losoAcc.total)}  (${r.losoAcc.hits}/${r.losoAcc.total})`);
  }
  console.log();
  console.log(`  TOTAL                    in=${fmtPct(inH, inT)}  loso=${fmtPct(lH, lT)}  (${lH}/${lT})`);

  if (opts.write) {
    const out = {
      asOf: new Date().toISOString().slice(0, 10),
      note: 'Auto-generated by scripts/audit-tony-loso.ts default run (SHIPPED_PROCEDURE config). Source of truth for the LOSO disclosure on /tony-awards/predictions. Re-run after any TONY_RECIPES or SHIPPED_PROCEDURE change to keep the displayed number in sync with the shipped model.',
      shippedRecipes: SHIPPED_RECIPES,
      shippedProcedure: SHIPPED_PROCEDURE,
      totalLoso: { hits: lH, total: lT, pct: lT ? Math.round((lH / lT) * 1000) / 10 : 0 },
      totalInSample: { hits: inH, total: inT, pct: inT ? Math.round((inH / inT) * 1000) / 10 : 0 },
      perCategory: perCategoryStats,
    };
    const dst = path.resolve(__dirname, '..', 'data', 'tony-loso-stats.json');
    fs.writeFileSync(dst, JSON.stringify(out, null, 2) + '\n');
    console.log(`\n[audit-tony-loso] wrote ${path.relative(path.resolve(__dirname, '..'), dst)}`);
  }

  if (PERMUTATIONS > 0) {
    console.log();
    console.log('========================================================');
    console.log(`Permutation null — ${PERMUTATIONS} runs at per-cat configs`);
    console.log('========================================================');
    const fixturesByCat = new Map<TonyCategoryKey, SeasonFixture[]>();
    for (const c of CATEGORY_KEYS) fixturesByCat.set(c, loadFixtures(c));

    const observedHits = lH;
    const observedTotal = lT;

    const draws: number[] = [];
    for (let p = 0; p < PERMUTATIONS; p++) {
      let pH = 0;
      for (const catKey of CATEGORY_KEYS) {
        const config = perCat.get(catKey);
        if (!config) continue;
        const orig = fixturesByCat.get(catKey)!;
        const shuffled = orig.map((f) => {
          const idx = Math.floor(Math.random() * f.nominees.length);
          return { ...f, winnerShowId: f.nominees[idx].showId };
        });
        const r = losoForCategory(catKey, config, shuffled);
        pH += r.losoAcc.hits;
      }
      draws.push(pH);
      if ((p + 1) % Math.max(1, Math.floor(PERMUTATIONS / 10)) === 0) {
        process.stderr.write(`  ${p + 1}/${PERMUTATIONS}\r`);
      }
    }
    process.stderr.write('\n');

    draws.sort((a, b) => a - b);
    const ge = draws.filter((d) => d >= observedHits).length;
    const pValue = ge / PERMUTATIONS;
    const median = draws[Math.floor(PERMUTATIONS / 2)];
    const p90 = draws[Math.floor(PERMUTATIONS * 0.9)];
    const p95 = draws[Math.floor(PERMUTATIONS * 0.95)];
    const p99 = draws[Math.floor(PERMUTATIONS * 0.99)];
    console.log(`Observed: ${observedHits}/${observedTotal} = ${fmtPct(observedHits, observedTotal)}`);
    console.log(`Null distribution (hits/${observedTotal}):  median=${median}  p90=${p90}  p95=${p95}  p99=${p99}`);
    console.log(`  draws ≥ observed (${observedHits}): ${ge}/${PERMUTATIONS}  →  p = ${pValue.toFixed(3)}`);
  }
}

function runParityCheck(perCat: Map<TonyCategoryKey, Config>): void {
  console.log('========================================================');
  console.log('Parity check: shipped vs refit picks on CURRENT season');
  console.log('========================================================');
  const allShows = getBroadwayShows();
  const currentSeason = getTonySeasonWindow();
  console.log(`  season: ${currentSeason.label}`);
  const eligible = getEligibleShows(allShows, currentSeason);
  const categories = groupIntoCategories(eligible, { nomineesOnly: true, season: currentSeason });

  for (const catKey of CATEGORY_KEYS) {
    const config = perCat.get(catKey);
    if (!config) continue;
    const cat = categories.find((c) => c.key === catKey);
    if (!cat || cat.shows.length === 0) {
      console.log(`\n--- ${catKey}: no nominees in current season ---`);
      continue;
    }

    // Build NomEntries for current season nominees
    const nominees: NomEntry[] = [];
    for (const s of cat.shows) {
      const show = eligible.find((e) => e.slug === s.slug);
      if (!show) continue;
      const cast = castActingNomsScore(show.id, currentSeason);
      nominees.push({
        showId: show.id,
        tags: show.tags ?? [],
        critic: show.compositeScore,
        audience: computeTonyAudienceGrade(show.id),
        awards: categoryAwardsScore(show.id, catKey),
        castNomsScore: cast ?? 0,
        belowLineScore: belowTheLineNomsScore(show.id, catKey),
      });
    }

    // Refit recipes on all historical fixtures
    const fixtures = loadFixtures(catKey);
    // Stamp sweepConvScore with no exclusion (production behavior)
    for (const f of fixtures) for (const n of f.nominees) n.sweepConvScore = precursorSweepConversionScore(n.showId, catKey);
    for (const n of nominees) n.sweepConvScore = precursorSweepConversionScore(n.showId, catKey);
    const awardsCfg = (config as Config).awardsCfg ?? SHIPPED_AWARDS_CONFIG;
    const refitRecipes = trainRecipes(fixtures, catKey, config, awardsCfg);
    const shippedRecipe = SHIPPED_RECIPES[catKey];

    const rank = (recipes: Recipe[]) => nominees
      .map((n) => ({ showId: n.showId, score: scoreFor(n, recipes, catKey, currentSeason.label, awardsCfg) }))
      .filter((r) => r.score != null)
      .sort((a, b) => (b.score! - a.score!));

    const shippedRanked = rank([shippedRecipe]);
    const refitRanked = rank(refitRecipes);

    const avg: Recipe = {
      critic: refitRecipes.reduce((s, r) => s + r.critic, 0) / refitRecipes.length,
      audience: refitRecipes.reduce((s, r) => s + r.audience, 0) / refitRecipes.length,
      awards: refitRecipes.reduce((s, r) => s + r.awards, 0) / refitRecipes.length,
    };
    console.log(`\n--- ${catKey} ---`);
    console.log(`  shipped ${fmtWeights(shippedRecipe)}`);
    for (const r of shippedRanked.slice(0, 5)) {
      console.log(`    ${r.score!.toFixed(1)}  ${r.showId}`);
    }
    console.log(`  refit (${refitRecipes.length} recipe${refitRecipes.length > 1 ? 's' : ''} avg=${fmtWeights(avg)})`);
    for (const r of refitRanked.slice(0, 5)) {
      console.log(`    ${r.score!.toFixed(1)}  ${r.showId}`);
    }
    const shippedTop = shippedRanked[0]?.showId;
    const refitTop = refitRanked[0]?.showId;
    if (shippedTop !== refitTop) {
      console.log(`  ⚠ TOP-1 FLIP: shipped=${shippedTop}  refit=${refitTop}`);
    } else {
      console.log(`  ✓ top-1 stable: ${shippedTop}`);
    }
  }
}

function runRefitAll(perCat: Map<TonyCategoryKey, Config>): void {
  console.log('========================================================');
  console.log('Refit on ALL seasons — production constants');
  console.log('========================================================');
  for (const catKey of CATEGORY_KEYS) {
    const config = perCat.get(catKey);
    if (!config) continue;
    const fixtures = loadFixtures(catKey);
    for (const f of fixtures) for (const n of f.nominees) n.sweepConvScore = precursorSweepConversionScore(n.showId, catKey);
    const awardsCfg = (config as Config).awardsCfg ?? SHIPPED_AWARDS_CONFIG;
    const recipes = trainRecipes(fixtures, catKey, config, awardsCfg);
    const inSample = trainingAccuracy(fixtures, catKey, recipes, awardsCfg);
    console.log(`\n--- ${catKey} (${configLabel(config)}) ---`);
    console.log(`  In-sample with refit recipes: ${inSample.hits}/${inSample.total}  (${fmtPct(inSample.hits, inSample.total)})`);
    console.log(`  Recipes (${recipes.length}):`);
    for (const r of recipes) console.log(`    ${fmtWeights(r)}`);
  }
}

// Awards-term sub-weight sweep. Holds the per-category fitting PROCEDURE
// constant (each cat uses its SHIPPED_PROCEDURE objective). Varies the
// awardsCfg sub-weights {baseline, sweepConv, castNoms} and reports per-cat
// LOSO for each. Helps decide whether the new features should ship and how
// they should be blended in categoryAwardsScore.
async function runAwardsSweep(): Promise<void> {
  const VARIANTS: Array<{ name: string; cfg: AwardsConfig }> = [
    { name: 'shipped (baseline only)',     cfg: { baseline: 1.0, sweepConv: 0.0, castNoms: 0.0, belowLine: 0.0 } },
    { name: 'pure castNoms',               cfg: { baseline: 0.0, sweepConv: 0.0, castNoms: 1.0, belowLine: 0.0 } },
    { name: 'pure belowLine',              cfg: { baseline: 0.0, sweepConv: 0.0, castNoms: 0.0, belowLine: 1.0 } },
    { name: 'pure sweepConv',              cfg: { baseline: 0.0, sweepConv: 1.0, castNoms: 0.0, belowLine: 0.0 } },
    { name: 'castNoms+belowLine 50/50',    cfg: { baseline: 0.0, sweepConv: 0.0, castNoms: 0.5, belowLine: 0.5 } },
    { name: 'castNoms+belowLine 70/30',    cfg: { baseline: 0.0, sweepConv: 0.0, castNoms: 0.7, belowLine: 0.3 } },
    { name: 'castNoms+belowLine 30/70',    cfg: { baseline: 0.0, sweepConv: 0.0, castNoms: 0.3, belowLine: 0.7 } },
    { name: 'baseline+castNoms 70/30',     cfg: { baseline: 0.7, sweepConv: 0.0, castNoms: 0.3, belowLine: 0.0 } },
    { name: 'baseline+castNoms 50/50',     cfg: { baseline: 0.5, sweepConv: 0.0, castNoms: 0.5, belowLine: 0.0 } },
    { name: 'baseline+belowLine 70/30',    cfg: { baseline: 0.7, sweepConv: 0.0, castNoms: 0.0, belowLine: 0.3 } },
    { name: 'baseline+belowLine 50/50',    cfg: { baseline: 0.5, sweepConv: 0.0, castNoms: 0.0, belowLine: 0.5 } },
    { name: 'baseline+cast+below 50/25/25', cfg: { baseline: 0.5, sweepConv: 0.0, castNoms: 0.25, belowLine: 0.25 } },
    { name: 'cast+below+baseline 33/33/33', cfg: { baseline: 1/3, sweepConv: 0.0, castNoms: 1/3, belowLine: 1/3 } },
  ];

  console.log('========================================================');
  console.log('Awards-term sub-weight sweep');
  console.log('========================================================');
  console.log('Held the per-category fitting procedure constant (SHIPPED_PROCEDURE).');
  console.log('Varied awardsCfg = {baseline, sweepConv, castNoms} sub-weights.');
  console.log();

  // Per-category table: variant name → LOSO hits
  const perCatResults: Record<TonyCategoryKey, Array<{ variant: string; loso: number; total: number }>> = {
    'best-musical': [],
    'best-play': [],
    'best-revival-musical': [],
    'best-revival-play': [],
  };

  for (const v of VARIANTS) {
    let totalH = 0, totalN = 0;
    const catH: Record<string, number> = {};
    const catN: Record<string, number> = {};
    for (const catKey of CATEGORY_KEYS) {
      const proc = SHIPPED_PROCEDURE[catKey];
      const config: Config = { ...proc, awardsCfg: v.cfg };
      const r = losoForCategory(catKey, config);
      catH[catKey] = r.losoAcc.hits;
      catN[catKey] = r.losoAcc.total;
      totalH += r.losoAcc.hits;
      totalN += r.losoAcc.total;
      perCatResults[catKey].push({ variant: v.name, loso: r.losoAcc.hits, total: r.losoAcc.total });
    }
    const breakdown = CATEGORY_KEYS.map((c) => `${catH[c]}/${catN[c]}`).join(' ');
    console.log(`${v.name.padEnd(40)}  total=${totalH}/${totalN} (${fmtPct(totalH, totalN)})  per-cat: ${breakdown}`);
  }

  // Per-category best variant
  console.log();
  console.log('Per-category best variant (by LOSO hits, tie-break by variant order):');
  for (const catKey of CATEGORY_KEYS) {
    const results = perCatResults[catKey];
    results.sort((a, b) => b.loso - a.loso);
    const baseline = results.find((r) => r.variant === 'shipped (baseline only)')!;
    const top = results[0];
    const gain = top.loso - baseline.loso;
    const flag = gain > 0 ? `+${gain} hits over shipped` : (gain === 0 ? 'no gain' : `${gain} hits worse`);
    console.log(`  ${catKey.padEnd(22)} best=${top.loso}/${top.total}  shipped=${baseline.loso}/${baseline.total}  (${flag})`);
    console.log(`    winner: "${top.variant}"`);
    if (results[1] && results[1].loso === top.loso) {
      const tied = results.filter((r) => r.loso === top.loso).map((r) => r.variant);
      console.log(`    tied at top: ${tied.length} variants — ${tied.join('; ')}`);
    }
  }

  console.log();
  console.log('Ship rule: per category, ship a non-shipped variant only if:');
  console.log('  - LOSO gain ≥ 2 hits OR total LOSO ≥ +2 over shipped 38/43');
  console.log('  - 2025-26 softmax delta ≤ ±5pp on all 4 races (separate --parity check)');
  console.log('  - Permutation null Bonferroni p<0.0125 per category (separate --permutations check)');
}

// ── Naive precursor-leader baseline ──────────────────────────────────────
// dsbuddy/r-dataisbeautiful-style reference point: ignore critic, audience and
// the feasibility filter entirely; just pick the nominee with the strongest
// top-category precursor signal (rank by topCatPrecursorScore across DL/OCC/DD
// wins+noms). Parameter-free, so there is nothing to train — the same number
// is both in-sample and out-of-sample. Ties at the top (incl. the all-zero
// "no precursor signal" case) are scored as a fair coin-flip: the winner is
// credited 1/(#tied) of a hit, so nominee ordering can't bias the number and
// the denominator stays equal to the model's 43 contests.
function runBaseline(): void {
  console.log('========================================================');
  console.log('Naive precursor-leader baseline (rank by topCatPrecursorScore)');
  console.log('========================================================');
  let totH = 0, totN = 0;
  for (const catKey of CATEGORY_KEYS) {
    const title = CATEGORY_KEY_TO_TITLE[catKey];
    const fixtures = loadFixtures(catKey);
    let h = 0, n = 0;
    for (const f of fixtures) {
      const ranked = f.nominees
        .map((nm) => ({ showId: nm.showId, s: topCatPrecursorScore(nm.showId, title) }))
        .sort((a, b) => b.s - a.s);
      if (ranked.length === 0) continue;
      const maxS = ranked[0].s;
      const tied = ranked.filter((r) => r.s === maxS);
      n++;
      if (tied.some((r) => r.showId === f.winnerShowId)) h += 1 / tied.length;
    }
    totH += h; totN += n;
    console.log(`  ${catKey.padEnd(22)}  ${h.toFixed(1)}/${n}  (${fmtPct(h, n)})`);
  }
  console.log();
  console.log(`  TOTAL precursor-leader baseline: ${totH.toFixed(1)}/${totN} = ${fmtPct(totH, totN)}`);
  console.log(`  (Run the default audit for the shipped-model LOSO to compare.)`);
}

// ── LOSO calibration / reliability table ─────────────────────────────────
// For every held-out fold, train the shipped per-category procedure on the
// other seasons, then read the softmax probability (T=T_SOFTMAX) the model
// assigns to its own top pick. Bin those probabilities and compare predicted
// confidence vs the actual hit rate — the dsbuddy "things it calls 75%+ win
// ~79% of the time" reliability check, done out-of-sample.
function topPickProb(
  fixture: SeasonFixture,
  catKey: TonyCategoryKey,
  recipes: Recipe[],
  awardsCfg: AwardsConfig,
  T: number,
): { showId: string; prob: number } | null {
  const scored = fixture.nominees
    .map((nm) => ({ showId: nm.showId, score: scoreFor(nm, recipes, catKey, fixture.label, awardsCfg) }))
    .filter((r): r is { showId: string; score: number } => r.score != null);
  if (scored.length === 0) return null;
  const maxS = Math.max(...scored.map((s) => s.score));
  const exps = scored.map((s) => Math.exp((s.score - maxS) / T));
  const sum = exps.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  let bestI = 0;
  for (let i = 1; i < scored.length; i++) if (scored[i].score > scored[bestI].score) bestI = i;
  return { showId: scored[bestI].showId, prob: exps[bestI] / sum };
}

function runCalibration(): void {
  console.log();
  console.log('========================================================');
  console.log(`LOSO calibration (softmax T=${T_SOFTMAX}, shipped procedure per category)`);
  console.log('========================================================');
  const records: Array<{ p: number; hit: number }> = [];
  for (const catKey of CATEGORY_KEYS) {
    const proc = SHIPPED_PROCEDURE[catKey];
    const fixtures = loadFixtures(catKey);
    for (let i = 0; i < fixtures.length; i++) {
      const held = fixtures[i];
      const train = fixtures.filter((_, j) => j !== i);
      stampSweepConvScores(fixtures, catKey, held.label);
      const recipes = trainRecipes(train, catKey, proc, SHIPPED_AWARDS_CONFIG);
      const tp = topPickProb(held, catKey, recipes, SHIPPED_AWARDS_CONFIG, T_SOFTMAX);
      if (!tp) continue;
      records.push({ p: tp.prob, hit: tp.showId === held.winnerShowId ? 1 : 0 });
    }
  }
  const bins: Array<{ lo: number; hi: number; label: string }> = [
    { lo: 0.0, hi: 0.6, label: '< 60%' },
    { lo: 0.6, hi: 0.8, label: '60–80%' },
    { lo: 0.8, hi: 1.01, label: '80–100%' },
  ];
  console.log('  bucket     n   mean predicted   actual hit rate');
  console.log('  ' + '-'.repeat(50));
  for (const b of bins) {
    const inBin = records.filter((r) => r.p >= b.lo && r.p < b.hi);
    if (inBin.length === 0) { console.log(`  ${b.label.padEnd(8)}   0          n/a               n/a`); continue; }
    const meanP = inBin.reduce((s, r) => s + r.p, 0) / inBin.length;
    const hitRate = inBin.reduce((s, r) => s + r.hit, 0) / inBin.length;
    console.log(`  ${b.label.padEnd(8)}  ${String(inBin.length).padStart(2)}     ${(meanP * 100).toFixed(1)}%            ${(hitRate * 100).toFixed(1)}%`);
  }
  const overallP = records.reduce((s, r) => s + r.p, 0) / records.length;
  const overallHit = records.reduce((s, r) => s + r.hit, 0) / records.length;
  const brier = records.reduce((s, r) => s + (r.p - r.hit) ** 2, 0) / records.length;
  console.log('  ' + '-'.repeat(50));
  console.log(`  overall   ${String(records.length).padStart(2)}     ${(overallP * 100).toFixed(1)}%            ${(overallHit * 100).toFixed(1)}%`);
  console.log(`  Brier score (top-pick prob vs hit): ${brier.toFixed(3)}  (lower is better; 0 = perfect)`);
}

function main(): void {
  if (process.argv.includes('--baseline')) {
    runBaseline();
    runCalibration();
    return;
  }
  if (AWARDS_SWEEP) {
    runAwardsSweep();
    return;
  }
  let perCat = parsePerCat();
  // Default: mirror the shipped per-category fitting procedure (see
  // SHIPPED_PROCEDURE). This makes the default run reproduce the 38/43 = 88.4%
  // LOSO figure displayed on /tony-awards/predictions. A user who overrides
  // with --objective= or --sweep gets the global behavior instead.
  const usingDefaults =
    !perCat &&
    !SWEEP &&
    !argVal('objective') &&
    !argVal('shrinkage') &&
    !argVal('ensemble');
  if (usingDefaults) {
    perCat = new Map(Object.entries(SHIPPED_PROCEDURE)) as Map<TonyCategoryKey, Config>;
  }
  if (perCat && process.argv.includes('--refit-all')) {
    runRefitAll(perCat);
    return;
  }
  if (perCat && process.argv.includes('--parity')) {
    runParityCheck(perCat);
    return;
  }
  if (perCat) {
    // When the default per-cat (SHIPPED_PROCEDURE) is in use, also write the
    // canonical stats JSON that the /tony-awards/predictions disclosure reads.
    // Explicit --per-cat= overrides are exploratory, so skip the write.
    runPerCatLOSO(perCat, { write: usingDefaults });
    return;
  }
  if (SWEEP) {
    runSweep();
    return;
  }

  const config: Config = { objective: OBJECTIVE, shrinkage: SHRINKAGE, ensembleK: ENSEMBLE_K };

  console.log('========================================================');
  console.log('Tony Predictions — Leave-One-Season-Out Cross-Validation');
  console.log('========================================================');
  console.log(`Grid step: ${STEP}  |  config: ${configLabel(config)}`);
  console.log('For each season, recipe weights are refit on the other 10');
  console.log('seasons, then applied to the held-out season.');
  console.log();

  const r = runLOSO(config, true);

  console.log('\n========================================================');
  console.log('SUMMARY');
  console.log('========================================================');
  console.log(`  Config: ${configLabel(config)}`);
  console.log(`  In-sample (shipped recipes applied to all seasons):`);
  console.log(`    ${r.totalInSample.hits}/${r.totalInSample.total}  =  ${fmtPct(r.totalInSample.hits, r.totalInSample.total)}`);
  console.log(`  LOSO (weights refit per fold, held-out evaluated):`);
  console.log(`    ${r.totalLoso.hits}/${r.totalLoso.total}  =  ${fmtPct(r.totalLoso.hits, r.totalLoso.total)}`);
  const drop = (r.totalInSample.hits / r.totalInSample.total) - (r.totalLoso.hits / r.totalLoso.total);
  console.log(`  Drop (overfit signal):  ${(drop * 100).toFixed(1)} percentage points`);
  console.log();
  console.log('Per-category:');
  for (const s of r.summaries) {
    console.log(`  ${s.catKey.padEnd(22)}  in=${fmtPct(s.inSampleAcc.hits, s.inSampleAcc.total)}  loso=${fmtPct(s.losoAcc.hits, s.losoAcc.total)}`);
  }

  if (PERMUTATIONS > 0) {
    console.log();
    runPermutationNull(config, PERMUTATIONS);
  }
}

main();
