/**
 * Brute-force weight search for Best Play tonyComposite recipe.
 *
 * Iterates {critic, audience, awards} weight triples summing to 1.0 (step 0.05)
 * and reports the top combinations by accuracy on the 11-season Best Play
 * backtest. Awards term is dropped when the show has no precursor signal
 * (matches tonyComposite behavior), so the formula doesn't penalize pre-
 * precursor shows.
 *
 * Usage:
 *   npx tsx scripts/search-tony-best-play-weights.ts            # default step 0.05
 *   npx tsx scripts/search-tony-best-play-weights.ts --step=0.1 # coarser
 *   npx tsx scripts/search-tony-best-play-weights.ts --top=30   # show more rows
 *   npx tsx scripts/search-tony-best-play-weights.ts --cat=best-musical
 */

import { getBroadwayShows } from '../src/lib/data-core';
import {
  getAllPredictionSeasons,
  getEligibleShowsForPastSeason,
  groupIntoCategories,
  getWinnersForSeason,
  computeAwardsScore,
  computeTonyAudienceGrade,
  type TonyCategoryKey,
} from '../src/lib/data-tony-predictions';

const CATEGORY_KEY_TO_TITLE: Record<TonyCategoryKey, string> = {
  'best-musical': 'Best Musical',
  'best-play': 'Best Play',
  'best-revival-musical': 'Best Revival of a Musical',
  'best-revival-play': 'Best Revival of a Play',
};

const stepArg = process.argv.find((a) => a.startsWith('--step='));
const STEP = stepArg ? parseFloat(stepArg.split('=')[1]) : 0.05;
const topArg = process.argv.find((a) => a.startsWith('--top='));
const TOP = topArg ? parseInt(topArg.split('=')[1], 10) : 15;
const catArg = process.argv.find((a) => a.startsWith('--cat='));
const CAT_KEY: TonyCategoryKey = (catArg ? catArg.split('=')[1] : 'best-play') as TonyCategoryKey;
const CAT_TITLE = CATEGORY_KEY_TO_TITLE[CAT_KEY];

function compositeForWeights(
  critic: number | null,
  audience: number | null,
  awards: number,
  w: { critic: number; audience: number; awards: number },
): number | null {
  const components: Array<{ weight: number; value: number }> = [];
  if (w.critic > 0 && critic != null) components.push({ weight: w.critic, value: critic });
  if (w.audience > 0 && audience != null) components.push({ weight: w.audience, value: audience });
  if (w.awards > 0 && awards > 0) components.push({ weight: w.awards, value: awards });
  if (components.length === 0) return null;
  const total = components.reduce((s, c) => s + c.weight, 0);
  return components.reduce((s, c) => s + (c.weight / total) * c.value, 0);
}

interface SeasonFixture {
  label: string;
  winner: { showId: string; critic: number | null; audience: number | null; awards: number } | null;
  nominees: Array<{ showId: string; critic: number | null; audience: number | null; awards: number }>;
}

function loadFixtures(): SeasonFixture[] {
  const seasons = getAllPredictionSeasons();
  const allShows = getBroadwayShows();
  const fixtures: SeasonFixture[] = [];

  for (const season of seasons) {
    const eligible = getEligibleShowsForPastSeason(allShows, season);
    const categories = groupIntoCategories(eligible, { nomineesOnly: true, season });
    const cat = categories.find((c) => c.key === CAT_KEY);
    if (!cat || cat.shows.length === 0) continue;

    const winners = getWinnersForSeason(season);
    const winnerShowId = winners.get(CAT_TITLE);
    if (!winnerShowId) continue; // season without recorded winner — skip

    // Build per-nominee fixture entries from raw inputs (critic, tony audience,
    // awards) — independent of any specific recipe.
    const nomEntries = cat.shows
      .map((s) => {
        const show = eligible.find((e) => e.id === s.slug.replace(/^.*\//, '')) ||
          eligible.find((e) => e.slug === s.slug);
        if (!show) return null;
        return {
          showId: show.id,
          critic: show.compositeScore,
          audience: computeTonyAudienceGrade(show.id),
          awards: computeAwardsScore(show.id, CAT_TITLE),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    const winnerEntry = nomEntries.find((n) => n.showId === winnerShowId) || null;
    fixtures.push({ label: season.label, winner: winnerEntry, nominees: nomEntries });
  }

  return fixtures;
}

function accuracyForWeights(fixtures: SeasonFixture[], w: { critic: number; audience: number; awards: number }): {
  hits: number;
  total: number;
} {
  let hits = 0;
  let total = 0;
  for (const f of fixtures) {
    if (!f.winner) continue;
    const ranked = f.nominees
      .map((n) => ({ ...n, score: compositeForWeights(n.critic, n.audience, n.awards, w) }))
      .filter((r) => r.score != null)
      .sort((a, b) => (b.score! - a.score!));
    if (ranked.length === 0) continue;
    total++;
    if (ranked[0].showId === f.winner.showId) hits++;
  }
  return { hits, total };
}

function main(): void {
  console.log(`Category: ${CAT_KEY} (${CAT_TITLE})`);
  console.log(`Weight step: ${STEP}`);
  console.log('Loading fixtures...');
  const fixtures = loadFixtures();
  console.log(`Fixtures: ${fixtures.length} seasons with recorded winners`);
  console.log();

  // Iterate w.critic + w.audience + w.awards = 1.0, step = STEP
  const grid: Array<{ w: { critic: number; audience: number; awards: number }; hits: number; total: number }> = [];
  const stepInt = Math.round(STEP * 100);
  for (let cr = 0; cr <= 100; cr += stepInt) {
    for (let au = 0; au <= 100 - cr; au += stepInt) {
      const aw = 100 - cr - au;
      const w = { critic: cr / 100, audience: au / 100, awards: aw / 100 };
      const { hits, total } = accuracyForWeights(fixtures, w);
      grid.push({ w, hits, total });
    }
  }

  // Sort by accuracy desc, then by lower critic weight (preference for simpler recipes)
  grid.sort((a, b) => {
    const accA = a.total ? a.hits / a.total : 0;
    const accB = b.total ? b.hits / b.total : 0;
    if (accA !== accB) return accB - accA;
    // Tiebreaker: prefer recipes closer to balanced
    const balA = Math.max(a.w.critic, a.w.audience, a.w.awards);
    const balB = Math.max(b.w.critic, b.w.audience, b.w.awards);
    return balA - balB;
  });

  // Leave-one-out cross-validation: for each candidate recipe in the top tier,
  // hold out 1 season at a time, find the BEST weights on the remaining 10
  // seasons, then score the held-out season. Average accuracy across the 11
  // folds. A genuinely robust recipe scores ≥ Tier 1 baseline.
  function loocvAccuracy(_w: { critic: number; audience: number; awards: number }): {
    avgAcc: number;
    holdouts: Array<{ heldSeason: string; bestWeights: { critic: number; audience: number; awards: number }; predictedHit: boolean }>;
  } {
    const holdouts: Array<{ heldSeason: string; bestWeights: { critic: number; audience: number; awards: number }; predictedHit: boolean }> = [];
    let hits = 0;
    for (let i = 0; i < fixtures.length; i++) {
      const held = fixtures[i];
      const train = fixtures.filter((_, j) => j !== i);
      // Find best weights on train set
      let best = { w: { critic: 0, audience: 0, awards: 0 }, acc: -1 };
      for (let cr = 0; cr <= 100; cr += stepInt) {
        for (let au = 0; au <= 100 - cr; au += stepInt) {
          const aw = 100 - cr - au;
          const w = { critic: cr / 100, audience: au / 100, awards: aw / 100 };
          const { hits, total } = accuracyForWeights(train, w);
          const acc = total ? hits / total : 0;
          if (acc > best.acc) best = { w, acc };
        }
      }
      // Score held-out
      const heldRes = accuracyForWeights([held], best.w);
      const hit = heldRes.hits === 1;
      holdouts.push({ heldSeason: held.label, bestWeights: best.w, predictedHit: hit });
      if (hit) hits++;
    }
    return { avgAcc: hits / fixtures.length, holdouts };
  }

  console.log(`Leave-one-out CV (true generalization):`);
  const loocv = loocvAccuracy(grid[0].w);
  console.log(`  ${loocv.holdouts.filter((h) => h.predictedHit).length}/${fixtures.length} held-out winners correctly predicted = ${(loocv.avgAcc * 100).toFixed(1)}%`);
  console.log(`  Per-fold best weights vary:`);
  for (const h of loocv.holdouts) {
    const mark = h.predictedHit ? '✓' : '✗';
    console.log(`    ${mark} hold-out ${h.heldSeason}: best train weights ${h.bestWeights.critic.toFixed(2)}/${h.bestWeights.audience.toFixed(2)}/${h.bestWeights.awards.toFixed(2)}`);
  }
  console.log();
  console.log(`Top ${TOP} weight combinations (in-sample):`);
  console.log('  critic / audience / awards    accuracy');
  for (const entry of grid.slice(0, TOP)) {
    const pct = entry.total ? ((entry.hits / entry.total) * 100).toFixed(1) : '  n/a';
    console.log(`  ${entry.w.critic.toFixed(2)}  /  ${entry.w.audience.toFixed(2)}    /  ${entry.w.awards.toFixed(2)}     ${entry.hits}/${entry.total}  (${pct}%)`);
  }

  // Specifically compare current shipped recipe vs proposed Tier 2 vs optimal
  console.log();
  console.log('Reference points:');
  const refs: Array<[string, { critic: number; audience: number; awards: number }]> = [
    ['Tier 1 (shipped)            ', { critic: 0.4, audience: 0.4, awards: 0.2 }],
    ['Tier 2 (proposed in card)   ', { critic: 0.2, audience: 0.2, awards: 0.6 }],
    ['Awards-heavy                ', { critic: 0.1, audience: 0.1, awards: 0.8 }],
    ['50/50 critic+audience       ', { critic: 0.5, audience: 0.5, awards: 0.0 }],
    ['Critic-only                 ', { critic: 1.0, audience: 0.0, awards: 0.0 }],
    ['Audience-only               ', { critic: 0.0, audience: 1.0, awards: 0.0 }],
    ['Awards-only                 ', { critic: 0.0, audience: 0.0, awards: 1.0 }],
  ];
  for (const [name, w] of refs) {
    const { hits, total } = accuracyForWeights(fixtures, w);
    const pct = total ? ((hits / total) * 100).toFixed(1) : '  n/a';
    console.log(`  ${name} ${hits}/${total}  (${pct}%)`);
  }
}

main();
