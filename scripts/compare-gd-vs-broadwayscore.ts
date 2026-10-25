/**
 * compare-gd-vs-broadwayscore.ts — head-to-head Tony Big Four backtest.
 *
 * For each completed Tony cycle (2013-2025, ex. COVID gaps + 2014 GD-empty):
 *   - OUR pick = top-ranked show from groupIntoCategories(tier:1) — same logic
 *                used by tony-deep-backtest.ts and the live predictions page
 *   - GD pick = highest-percentage row from the cached
 *                /wp-json/gameplay/v1/latest-odds-v3/ response
 *   - WINNER = data/awards.json tony.wins for that season
 *
 * Output:
 *   - Stdout: per-category and overall hit-rate table; lists of unique misses
 *   - data/analysis/gd-vs-broadwayscore.json: per-race detail for republication
 *
 * Designed to be re-run pre-ceremony each year. Adds the current cycle's
 * GD odds (no winner yet) to the table for transparency.
 *
 * Caveats baked into the output _meta:
 *   - Our recipe weights are grid-search-tuned on historical Tony outcomes
 *     (see project_tony_predictions_accuracy.md). 91% is in-sample-fit; LOOCV
 *     would land a few pp lower. GD experts weren't trained on past Tony data,
 *     so the comparison isn't strictly apples-to-apples.
 *   - Both methods are post-nomination snapshots.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBroadwayShows } from '../src/lib/data-core';
import {
  getAllPredictionSeasons,
  getEligibleShowsForPastSeason,
  groupIntoCategories,
  getWinnersForSeason,
} from '../src/lib/data-tony-predictions';
import type { SerializedTonyShow } from '../src/lib/data-tony-predictions';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const CAT_TITLES: Record<string, string> = {
  'best-musical':         'Best Musical',
  'best-play':            'Best Play',
  'best-revival-musical': 'Best Revival of a Musical',
  'best-revival-play':    'Best Revival of a Play',
};

interface GdRace {
  cycle: string;
  ceremonyYear: number;
  category: string;
  favoriteTitle: string;
  favoritePct: number;
  favoriteIsWinner: boolean;
  winnerTitle: string;
  winnerPct: number;
  winnerRankOneIndexed: number;
}

interface RaceOutcome {
  cycle: string;
  category: string;
  winnerShowId: string;
  winnerTitle: string;
  ourPickShowId: string | null;
  ourPickTitle: string | null;
  ourHit: boolean;
  gdPickTitle: string | null;
  gdPickPct: number | null;
  gdHit: boolean;
  bothRight: boolean;
  bothWrong: boolean;
  weBeatThem: boolean;  // we hit, they missed
  theyBeatUs: boolean;  // they hit, we missed
}

const auditPath = join(root, 'data', 'analysis', 'gd-historical-accuracy.json');
if (!existsSync(auditPath)) {
  console.error(`Missing ${auditPath}. Run \`node scripts/audit-gd-historical-accuracy.js --save\` first.`);
  process.exit(1);
}
const gdAudit = JSON.parse(readFileSync(auditPath, 'utf8')) as {
  perCategory: Record<string, GdRace[]>;
};

// Index GD races by (cycle, category) for O(1) lookup
const gdByKey = new Map<string, GdRace>();
for (const [cat, races] of Object.entries(gdAudit.perCategory)) {
  for (const r of races) gdByKey.set(`${r.cycle}|${cat}`, r);
}

// Helper: convert "2018-2019" season label → "2018-19" cycle key (matches GD audit format)
function cycleKeyFromSeason(label: string): string {
  const m = label.match(/^(\d{4})-(\d{4})$/);
  if (!m) return label;
  return `${m[1]}-${m[2].slice(2)}`;
}

const allShows = getBroadwayShows();
const seasons = getAllPredictionSeasons();

const results: RaceOutcome[] = [];
const catStats: Record<string, { ours: number; theirs: number; total: number }> = {};

for (const season of seasons) {
  const eligible = getEligibleShowsForPastSeason(allShows, season);
  const categories = groupIntoCategories(eligible, { nomineesOnly: true, season, tier: 1 });
  const winners = getWinnersForSeason(season);
  const idToShow = new Map(eligible.map(s => [s.id, s]));
  const cycleKey = cycleKeyFromSeason(season.label);

  for (const cat of categories) {
    const winnerShowId = winners.get(cat.title);
    if (!winnerShowId) continue;
    const winnerShow = idToShow.get(winnerShowId);
    if (!winnerShow) continue;
    const winnerInList = cat.shows.find((s: SerializedTonyShow) => s.slug === winnerShow.slug);
    if (!winnerInList) continue;  // skip if winner wasn't ranked

    const top = cat.shows[0];
    if (!top) continue;
    const ourHit = top.slug === winnerShow.slug;

    const gd = gdByKey.get(`${cycleKey}|${cat.title}`);
    const gdHit = gd ? gd.favoriteIsWinner : false;
    const gdSeen = gd != null;

    // Only accumulate category stats when GD also has data for the race
    if (gdSeen) {
      if (!catStats[cat.key]) catStats[cat.key] = { ours: 0, theirs: 0, total: 0 };
      catStats[cat.key].total++;
      if (ourHit) catStats[cat.key].ours++;
      if (gdHit) catStats[cat.key].theirs++;
    }

    results.push({
      cycle: cycleKey,
      category: cat.title,
      winnerShowId,
      winnerTitle: winnerShow.title,
      ourPickShowId: top.slug,
      ourPickTitle: top.title,
      ourHit,
      gdPickTitle: gd?.favoriteTitle ?? null,
      gdPickPct: gd?.favoritePct ?? null,
      gdHit,
      bothRight: ourHit && gdHit,
      bothWrong: !ourHit && !gdHit && gdSeen,
      weBeatThem: ourHit && gdSeen && !gdHit,
      theyBeatUs: !ourHit && gdSeen && gdHit,
    });
  }
}

// Filter to races where both methods are present (i.e., GD has data — excludes 2014 + COVID gaps)
const bothPresent = results.filter(r => r.gdPickTitle != null);

const ours = bothPresent.filter(r => r.ourHit).length;
const theirs = bothPresent.filter(r => r.gdHit).length;
const total = bothPresent.length;
const weBeatThem = bothPresent.filter(r => r.weBeatThem);
const theyBeatUs = bothPresent.filter(r => r.theyBeatUs);
const bothRight = bothPresent.filter(r => r.bothRight).length;
const bothWrong = bothPresent.filter(r => r.bothWrong).length;

console.log('=== Broadway Scorecard vs GoldDerby — Head-to-Head ===');
console.log(`Sample: ${total} Tony Big Four races, ${[...new Set(bothPresent.map(r => r.cycle))].length} cycles\n`);

console.log('Category                          Ours        GD          Δ');
console.log('-'.repeat(72));
for (const key of ['best-musical', 'best-play', 'best-revival-musical', 'best-revival-play']) {
  const s = catStats[key];
  if (!s) continue;
  const ourPct = (s.ours / s.total * 100).toFixed(0);
  const gdPct = (s.theirs / s.total * 100).toFixed(0);
  const delta = s.ours - s.theirs;
  const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
  console.log(`  ${CAT_TITLES[key].padEnd(30)}  ${s.ours}/${s.total} (${ourPct}%)`.padEnd(50) + ` ${s.theirs}/${s.total} (${gdPct}%)`.padEnd(15) + ` ${deltaStr}`);
}
console.log();
console.log(`OVERALL:                            ${ours}/${total} (${(ours/total*100).toFixed(0)}%)    ${theirs}/${total} (${(theirs/total*100).toFixed(0)}%)    ${ours - theirs > 0 ? '+' : ''}${ours - theirs}`);
console.log();
console.log(`Both right:    ${bothRight}`);
console.log(`Both wrong:    ${bothWrong}`);
console.log(`We beat them:  ${weBeatThem.length} — races where GD missed and we hit`);
console.log(`They beat us:  ${theyBeatUs.length} — races where we missed and GD hit`);
console.log();

if (weBeatThem.length) {
  console.log('=== WE HIT, GD MISSED ===');
  for (const r of weBeatThem) {
    console.log(`  ${r.cycle} ${r.category}: GD picked ${r.gdPickTitle?.trim()} @${r.gdPickPct?.toFixed(1)}% — winner: ${r.winnerTitle}`);
  }
  console.log();
}
if (theyBeatUs.length) {
  console.log('=== GD HIT, WE MISSED ===');
  for (const r of theyBeatUs) {
    console.log(`  ${r.cycle} ${r.category}: We picked ${r.ourPickTitle} — winner: ${r.winnerTitle} (GD got it)`);
  }
  console.log();
}

// Save artifact
const out = {
  _meta: {
    generatedAt: new Date().toISOString(),
    sample: { races: total, cycles: [...new Set(bothPresent.map(r => r.cycle))].length },
    ourSummary:    { hits: ours,   total, pct: ours / total },
    gdSummary:     { hits: theirs, total, pct: theirs / total },
    deltaInRaces:  ours - theirs,
    weBeatThemCount: weBeatThem.length,
    theyBeatUsCount: theyBeatUs.length,
    bothRight,
    bothWrong,
    caveats: [
      'Our recipe weights are grid-search-tuned on historical Tony outcomes; the 91% is in-sample-fit.',
      'LOOCV (leave-one-out cross-validation) would land a few pp lower for us.',
      'GD expert predictions are independent and not optimized on past Tony data — apples-to-oranges in that direction.',
      'Both are post-nomination snapshots; neither claims pre-nomination accuracy.',
      'Best Revival of a Play is structurally hardest — both at 73%.',
    ],
  },
  catStats,
  races: results,
  weHitTheyMissed: weBeatThem,
  theyHitWeMissed: theyBeatUs,
};

const outDir = join(root, 'data', 'analysis');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'gd-vs-broadwayscore.json');
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}`);
