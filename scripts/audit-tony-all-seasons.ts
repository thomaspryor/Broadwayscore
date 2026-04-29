/**
 * Ship-check audit: walks every Tony season we generate a page for, applies
 * the new per-category model, and reports:
 *   - For each top category in each season: who's #1, who actually won, did
 *     we pick correctly, and how many nominees we ranked.
 *   - Aggregate accuracy by category.
 *   - Edge cases: shows with null components, awards-score distribution.
 */

import { getBroadwayShows } from '../src/lib/data-core';
import {
  getAllPredictionSeasons,
  getEligibleShowsForPastSeason,
  groupIntoCategories,
  getWinnersForSeason,
  computeAwardsScore,
  computeTonyAudienceGrade,
} from '../src/lib/data-tony-predictions';

function pct(n: number, d: number): string {
  if (!d) return ' n/a';
  return ((n / d) * 100).toFixed(1).padStart(5) + '%';
}

function main(): void {
  const seasons = getAllPredictionSeasons();
  const allShows = getBroadwayShows();

  const catCounts: Record<string, { total: number; rank1: number; missing: number }> = {
    'best-musical': { total: 0, rank1: 0, missing: 0 },
    'best-play': { total: 0, rank1: 0, missing: 0 },
    'best-revival-musical': { total: 0, rank1: 0, missing: 0 },
    'best-revival-play': { total: 0, rank1: 0, missing: 0 },
  };

  let totalNominees = 0;
  let nomineesWithNullComposite = 0;
  let nomineesWithNullAud = 0;
  const awardsDist: number[] = [];

  for (const season of seasons) {
    const eligible = getEligibleShowsForPastSeason(allShows, season);
    const categories = groupIntoCategories(eligible, { nomineesOnly: true, season });
    const winners = getWinnersForSeason(season);

    process.stdout.write(`\n${season.label.padEnd(10)} `);
    for (const cat of categories) {
      const winnerShowId = winners.get(cat.title);
      const winnerShow = winnerShowId
        ? eligible.find(s => s.id === winnerShowId)
        : null;

      const top = cat.shows[0] || null;
      const nomineeCount = cat.shows.length;

      // Stats
      for (const show of cat.shows) {
        totalNominees++;
        if (show.blendedScore == null) nomineesWithNullComposite++;
        if (show.tonyAudienceGrade == null) nomineesWithNullAud++;
        awardsDist.push(show.awardsScore);
      }

      if (!winnerShow) {
        // No winner data — older season we don't track winners for, skip
        process.stdout.write(`${cat.key[5]}=- `);
        continue;
      }

      catCounts[cat.key].total++;
      const correct = top && top.slug === winnerShow.slug;
      if (correct) {
        catCounts[cat.key].rank1++;
        process.stdout.write(`${cat.key[5]}✓ `);
      } else {
        const winnerInList = cat.shows.find(s => s.slug === winnerShow.slug);
        if (!winnerInList) {
          catCounts[cat.key].missing++;
          process.stdout.write(`${cat.key[5]}? `);
        } else {
          process.stdout.write(`${cat.key[5]}✗ `);
        }
      }
      void nomineeCount;
    }
  }

  console.log('\n\n=== Per-category accuracy across all tracked seasons ===');
  let grandTotal = 0;
  let grandWins = 0;
  for (const [key, stats] of Object.entries(catCounts)) {
    console.log(`  ${key.padEnd(22)} ${stats.rank1}/${stats.total}  (${pct(stats.rank1, stats.total)})  missing-from-list: ${stats.missing}`);
    grandTotal += stats.total;
    grandWins += stats.rank1;
  }
  console.log(`  ${''.padEnd(22)} ${'-'.repeat(40)}`);
  console.log(`  ${'TOTAL'.padEnd(22)} ${grandWins}/${grandTotal}  (${pct(grandWins, grandTotal)})`);

  console.log('\n=== Edge cases ===');
  console.log(`  Total nominees ranked:                ${totalNominees}`);
  console.log(`  Nominees with null composite score:   ${nomineesWithNullComposite}`);
  console.log(`  Nominees with null tonyAudienceGrade: ${nomineesWithNullAud}`);
  const awardsNonZero = awardsDist.filter(a => a > 0);
  const awardsAvg = awardsNonZero.reduce((s, v) => s + v, 0) / (awardsNonZero.length || 1);
  console.log(`  Awards score range: 0 to ${Math.max(...awardsDist).toFixed(1)} (avg of nonzero: ${awardsAvg.toFixed(1)})`);

  // Test the formula directly on a few hand-picked hard cases
  console.log('\n=== Spot-check: hand-picked 2023-24 + 2022-23 winners ===');
  for (const [showId, cat] of [
    ['stereophonic-2024', 'Best Play'],
    ['the-outsiders-2024', 'Best Musical'],
    ['merrily-we-roll-along-2023', 'Best Revival of a Musical'],
    ['leopoldstadt-2022', 'Best Play'],
  ] as const) {
    const aud = computeTonyAudienceGrade(showId);
    const aws = computeAwardsScore(showId, cat);
    console.log(`  ${showId.padEnd(34)} ${cat.padEnd(28)} aud=${aud == null ? '---' : aud.toFixed(1)}  aws=${aws.toFixed(1)}`);
  }
}

main();
