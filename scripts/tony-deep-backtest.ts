/**
 * Verbose Tony backtest: shows every category, every nominee ranked, with
 * market signals (GD/Polymarket/Kalshi) for the current season.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBroadwayShows } from '../src/lib/data-core';
import {
  getAllPredictionSeasons,
  getEligibleShowsForPastSeason,
  getEligibleShows,
  groupIntoCategories,
  getWinnersForSeason,
  computeAwardsScore,
  computeTonyAudienceGrade,
  getTonySeasonWindow,
} from '../src/lib/data-tony-predictions';
import type { SerializedTonyShow } from '../src/lib/data-tony-predictions';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pmRaw = JSON.parse(readFileSync(join(root, 'data/tony-polymarket-odds.json'), 'utf8'));
const kaRaw = JSON.parse(readFileSync(join(root, 'data/tony-kalshi-odds.json'), 'utf8'));

const CAT_TITLES: Record<string, string> = {
  'best-musical':         'Best Musical',
  'best-play':            'Best Play',
  'best-revival-musical': 'Best Revival of a Musical',
  'best-revival-play':    'Best Revival of a Play',
};

function pmFor(title: string, catTitle: string): number | null {
  const cat = (pmRaw.categories || {})[catTitle];
  if (!cat) return null;
  for (const [k, v] of Object.entries(cat.nominees || {})) {
    if ((k as string).toLowerCase().slice(0,12) === title.toLowerCase().slice(0,12)) return v as number;
    if (title.toLowerCase().includes((k as string).toLowerCase().slice(0,8))) return v as number;
  }
  return null;
}

function kaFor(title: string, catTitle: string): number | null {
  const cat = (kaRaw.categories || {})[catTitle];
  if (!cat) return null;
  for (const [k, v] of Object.entries(cat.nominees || {})) {
    if ((k as string).toLowerCase().slice(0,12) === title.toLowerCase().slice(0,12)) return v as number;
    if (title.toLowerCase().includes((k as string).toLowerCase().slice(0,8))) return v as number;
  }
  return null;
}

function pct(n: number | null): string {
  return n != null ? `${Math.round(n * 100)}%` : '—';
}

const allShows = getBroadwayShows();
const seasons = getAllPredictionSeasons();

// --- HISTORICAL BACKTEST WITH DETAIL ---
console.log('=== HISTORICAL BACKTEST (detailed misses) ===\n');

const catStats: Record<string, { r: number; t: number }> = {};
let totalR = 0, totalT = 0;

for (const season of seasons) {
  const eligible = getEligibleShowsForPastSeason(allShows, season);
  const categories = groupIntoCategories(eligible, { nomineesOnly: true, season, tier: 1 });
  const winners = getWinnersForSeason(season);

  // Build id→show map for slug lookups
  const idToShow = new Map(eligible.map(s => [s.id, s]));

  for (const cat of categories) {
    if (!catStats[cat.key]) catStats[cat.key] = { r: 0, t: 0 };
    const winnerShowId = winners.get(cat.title);
    if (!winnerShowId) continue;
    const winnerComputedShow = idToShow.get(winnerShowId);
    if (!winnerComputedShow) continue;
    const winnerSlug = winnerComputedShow.slug;

    const top = cat.shows[0];
    if (!top) continue;

    // Only count if winner is in ranked list
    const winnerInList = cat.shows.find((s: SerializedTonyShow) => s.slug === winnerSlug);
    if (!winnerInList) continue;

    catStats[cat.key].t++;
    totalT++;
    const correct = top.slug === winnerSlug;
    if (correct) {
      catStats[cat.key].r++;
      totalR++;
    } else {
      const winnerRank = cat.shows.findIndex((s: SerializedTonyShow) => s.slug === winnerSlug) + 1;
      console.log(`MISS — ${season.label} ${cat.title}`);
      console.log(`  Winner (rank #${winnerRank}): ${winnerComputedShow.title}`);
      for (const [i, show] of cat.shows.entries()) {
        const isW = show.slug === winnerSlug ? ' ← WINNER' : '';
        const aud = show.tonyAudienceGrade;
        const aws = show.awardsScore;
        const gd = show.gdOdds;
        console.log(`  #${i + 1} ${show.title.slice(0, 40).padEnd(40)} blend=${show.blendedScore?.toFixed(1).padStart(5) ?? '  n/a'}  crit=${show.compositeScore?.toFixed(0).padStart(3) ?? 'n/a'}  aud=${aud?.toFixed(0).padStart(3) ?? 'n/a'}  aws=${aws.toFixed(0).padStart(3)}  gd=${pct(gd ?? null).padStart(5)}${isW}`);
      }
      console.log();
    }
  }
}

console.log(`\nOVERALL: ${totalR}/${totalT} = ${totalT > 0 ? (100 * totalR / totalT).toFixed(1) : 'n/a'}%`);
for (const [k, v] of Object.entries(catStats)) {
  if (v.t) console.log(`  ${CAT_TITLES[k].padEnd(30)} ${v.r}/${v.t} (${(100 * v.r / v.t).toFixed(1)}%)`);
}

// --- CURRENT SEASON ---
console.log('\n\n=== CURRENT 2025-26 SEASON: OUR MODEL vs MARKETS ===\n');

const currentSeason = getTonySeasonWindow();
const currentEligible = getEligibleShows(allShows, currentSeason);
const currentCats = groupIntoCategories(currentEligible, { nomineesOnly: true, season: currentSeason, tier: 1 });

for (const cat of currentCats) {
  const catTitle = cat.title;
  console.log(`${catTitle} (${cat.shows.length} nominees + ${cat.upcoming?.length ?? 0} upcoming)`);
  console.log(`${'#'.padEnd(3)} ${'Show'.padEnd(42)} ${'Blend'.padStart(6)} ${'Crit'.padStart(5)} ${'Aud'.padStart(5)} ${'Aws'.padStart(5)} ${'GD%'.padStart(6)} ${'PM%'.padStart(6)} ${'KA%'.padStart(6)}`);
  console.log('-'.repeat(95));

  for (const [i, show] of cat.shows.entries()) {
    // Use pre-computed fields from SerializedTonyShow (avoid broken show.id access)
    const aud = show.tonyAudienceGrade;
    const aws = show.awardsScore;
    const gd = show.gdOdds ?? null;
    const pm = pmFor(show.title, catTitle);
    const ka = kaFor(show.title, catTitle);
    console.log(`#${(i + 1).toString().padEnd(2)} ${show.title.slice(0, 42).padEnd(42)} ${show.blendedScore?.toFixed(1).padStart(6) ?? '   n/a'}  ${show.compositeScore?.toFixed(0).padStart(4) ?? ' n/a'}  ${aud?.toFixed(0).padStart(4) ?? ' n/a'}  ${aws.toFixed(0).padStart(4)}  ${pct(gd).padStart(5)}  ${pct(pm).padStart(5)}  ${pct(ka).padStart(5)}`);
  }

  // Disagreement check
  const our1 = cat.shows[0];
  if (!our1) { console.log(); continue; }

  let gd1: { show: SerializedTonyShow; p: number } | null = null;
  let mkt1: { show: SerializedTonyShow; p: number } | null = null;
  for (const show of cat.shows) {
    const gd = show.gdOdds ?? null;
    const pm = pmFor(show.title, catTitle);
    const ka = kaFor(show.title, catTitle);
    if (gd != null && (!gd1 || gd > gd1.p)) gd1 = { show, p: gd };
    const mkt = [pm, ka].filter(x => x != null) as number[];
    const avgMkt = mkt.length ? mkt.reduce((a, b) => a + b) / mkt.length : 0;
    if (avgMkt > (mkt1?.p ?? 0)) mkt1 = { show, p: avgMkt };
  }

  const gdAgrees = !gd1 || gd1.show.slug === our1.slug;
  const mktAgrees = !mkt1 || mkt1.p < 0.30 || mkt1.show.slug === our1.slug;

  if (!gdAgrees) console.log(`  ⚠️  GD disagrees: GD #1 = ${gd1!.show.title} (${pct(gd1!.p)}) vs our ${our1.title}`);
  else if (gd1) console.log(`  ✓  GD agrees: ${our1.title} (${pct(gd1.p)})`);
  if (!mktAgrees) console.log(`  ⚠️  Prediction markets disagree: market #1 = ${mkt1!.show.title} (${pct(mkt1!.p)}) vs our ${our1.title}`);
  else if (mkt1?.p && mkt1.p > 0.30) console.log(`  ✓  Markets agree: ${our1.title}`);
  console.log();
}
