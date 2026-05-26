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

import { getBroadwayShows } from '../src/lib/data-core';
import {
  getAllPredictionSeasons,
  getEligibleShowsForPastSeason,
  groupIntoCategories,
  getWinnersForSeason,
  computeAwardsScore,
  computeTonyAudienceGrade,
  categoryAwardsScore,
  bestMusicalFeasibilityFactor,
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

const stepArg = process.argv.find((a) => a.startsWith('--step='));
const STEP = stepArg ? parseFloat(stepArg.split('=')[1]) : 0.05;
const STEP_INT = Math.round(STEP * 100);

const SHIPPED_RECIPES: Record<TonyCategoryKey, { critic: number; audience: number; awards: number }> = {
  'best-musical': { critic: 0.6, audience: 0.2, awards: 0.2 },
  'best-play': { critic: 0, audience: 0, awards: 1.0 },
  'best-revival-musical': { critic: 0.1, audience: 0.7, awards: 0.2 },
  'best-revival-play': { critic: 0.2, audience: 0.6, awards: 0.2 },
};

interface NomEntry {
  showId: string;
  tags: string[];
  critic: number | null;
  audience: number | null;
  awards: number;        // category-aware awards score (production formula)
  legacyAwards: number;  // for best-revival-play tier-1 path (categoryAwardsScore
                         // returns legacy in production; same here for consistency)
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
      nominees.push({
        showId: show.id,
        tags: show.tags ?? [],
        critic: show.compositeScore,
        audience: computeTonyAudienceGrade(show.id),
        awards: categoryAwardsScore(show.id, catKey),
        legacyAwards: computeAwardsScore(show.id, catTitle),
      });
    }
    // Only fold seasons where the winner is actually in the nominee fixture
    // (i.e., we have prediction inputs for them). Otherwise LOSO is meaningless.
    if (!nominees.some((n) => n.showId === winnerShowId)) continue;
    fixtures.push({ label: season.label, winnerShowId, nominees });
  }
  return fixtures;
}

function compositeFor(
  n: NomEntry,
  w: { critic: number; audience: number; awards: number },
): number | null {
  const components: Array<{ weight: number; value: number }> = [];
  if (w.critic > 0 && n.critic != null) components.push({ weight: w.critic, value: n.critic });
  if (w.audience > 0 && n.audience != null) components.push({ weight: w.audience, value: n.audience });
  if (w.awards > 0 && n.awards > 0) components.push({ weight: w.awards, value: n.awards });
  if (components.length === 0) return null;
  const total = components.reduce((s, c) => s + c.weight, 0);
  return components.reduce((s, c) => s + (c.weight / total) * c.value, 0);
}

function predictWinner(
  fixture: SeasonFixture,
  catKey: TonyCategoryKey,
  w: { critic: number; audience: number; awards: number },
): string | null {
  const ranked = fixture.nominees
    .map((n) => {
      let score = compositeFor(n, w);
      if (score != null) {
        const factor = bestMusicalFeasibilityFactor(n.showId, n.tags, catKey, fixture.label);
        score = score * factor;
      }
      return { showId: n.showId, score };
    })
    .filter((r) => r.score != null)
    .sort((a, b) => (b.score! - a.score!));
  return ranked[0]?.showId ?? null;
}

function trainingAccuracy(
  train: SeasonFixture[],
  catKey: TonyCategoryKey,
  w: { critic: number; audience: number; awards: number },
): { hits: number; total: number } {
  let hits = 0;
  let total = 0;
  for (const f of train) {
    const pick = predictWinner(f, catKey, w);
    if (pick == null) continue;
    total++;
    if (pick === f.winnerShowId) hits++;
  }
  return { hits, total };
}

function bestWeightsOnTraining(
  train: SeasonFixture[],
  catKey: TonyCategoryKey,
): { critic: number; audience: number; awards: number } {
  let best = {
    w: { critic: 0, audience: 0, awards: 0 },
    acc: -1,
    maxW: 999,
  };
  for (let cr = 0; cr <= 100; cr += STEP_INT) {
    for (let au = 0; au <= 100 - cr; au += STEP_INT) {
      const aw = 100 - cr - au;
      const w = { critic: cr / 100, audience: au / 100, awards: aw / 100 };
      const { hits, total } = trainingAccuracy(train, catKey, w);
      const acc = total ? hits / total : 0;
      const maxW = Math.max(w.critic, w.audience, w.awards);
      // Tiebreaker: lower max weight (more balanced) wins
      if (acc > best.acc || (acc === best.acc && maxW < best.maxW)) {
        best = { w, acc, maxW };
      }
    }
  }
  return best.w;
}

interface FoldResult {
  heldSeason: string;
  bestTrainWeights: { critic: number; audience: number; awards: number };
  predictedShowId: string | null;
  actualShowId: string;
  hit: boolean;
}

function losoForCategory(catKey: TonyCategoryKey): {
  catKey: TonyCategoryKey;
  inSampleAcc: { hits: number; total: number };
  losoAcc: { hits: number; total: number };
  folds: FoldResult[];
} {
  const fixtures = loadFixtures(catKey);
  // In-sample: shipped recipe applied to every season
  const shipped = SHIPPED_RECIPES[catKey];
  const inSample = trainingAccuracy(fixtures, catKey, shipped);

  const folds: FoldResult[] = [];
  let losoHits = 0;
  for (let i = 0; i < fixtures.length; i++) {
    const held = fixtures[i];
    const train = fixtures.filter((_, j) => j !== i);
    const trainedW = bestWeightsOnTraining(train, catKey);
    const pick = predictWinner(held, catKey, trainedW);
    const hit = pick === held.winnerShowId;
    if (hit) losoHits++;
    folds.push({
      heldSeason: held.label,
      bestTrainWeights: trainedW,
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

function main(): void {
  console.log('========================================================');
  console.log('Tony Predictions — Leave-One-Season-Out Cross-Validation');
  console.log('========================================================');
  console.log(`Grid step: ${STEP}`);
  console.log('For each season, recipe weights are refit on the other 10');
  console.log('seasons, then applied to the held-out season.');
  console.log();

  let totalInSampleHits = 0;
  let totalInSampleN = 0;
  let totalLosoHits = 0;
  let totalLosoN = 0;

  const summaries: ReturnType<typeof losoForCategory>[] = [];

  for (const catKey of CATEGORY_KEYS) {
    const r = losoForCategory(catKey);
    summaries.push(r);
    totalInSampleHits += r.inSampleAcc.hits;
    totalInSampleN += r.inSampleAcc.total;
    totalLosoHits += r.losoAcc.hits;
    totalLosoN += r.losoAcc.total;

    console.log(`\n--- ${catKey} (shipped recipe ${fmtWeights(SHIPPED_RECIPES[catKey])}) ---`);
    console.log(`  In-sample (shipped):   ${r.inSampleAcc.hits}/${r.inSampleAcc.total}  (${fmtPct(r.inSampleAcc.hits, r.inSampleAcc.total)})`);
    console.log(`  LOSO (held-out):       ${r.losoAcc.hits}/${r.losoAcc.total}  (${fmtPct(r.losoAcc.hits, r.losoAcc.total)})`);
    console.log(`  Per-fold:`);
    for (const f of r.folds) {
      const mark = f.hit ? '✓' : '✗';
      const wstr = fmtWeights(f.bestTrainWeights);
      console.log(`    ${mark} ${f.heldSeason}  trained ${wstr}  picked=${f.predictedShowId ?? '(none)'}  actual=${f.actualShowId}`);
    }
  }

  console.log('\n========================================================');
  console.log('SUMMARY');
  console.log('========================================================');
  console.log(`  In-sample (shipped recipes applied to all seasons):`);
  console.log(`    ${totalInSampleHits}/${totalInSampleN}  =  ${fmtPct(totalInSampleHits, totalInSampleN)}`);
  console.log(`  LOSO (weights refit per fold, held-out evaluated):`);
  console.log(`    ${totalLosoHits}/${totalLosoN}  =  ${fmtPct(totalLosoHits, totalLosoN)}`);
  const drop = (totalInSampleHits / totalInSampleN) - (totalLosoHits / totalLosoN);
  console.log(`  Drop (overfit signal):  ${(drop * 100).toFixed(1)} percentage points`);
  console.log();
  console.log('Per-category:');
  for (const s of summaries) {
    console.log(`  ${s.catKey.padEnd(22)}  in=${fmtPct(s.inSampleAcc.hits, s.inSampleAcc.total)}  loso=${fmtPct(s.losoAcc.hits, s.losoAcc.total)}`);
  }
}

main();
