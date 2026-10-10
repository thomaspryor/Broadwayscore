#!/usr/bin/env node
/**
 * audit-gd-historical-accuracy.js — Backtest GoldDerby's pre-ceremony Tony
 * predictions against actual winners.
 *
 * Reads from `.cache/gd/` (populated by `scrape-gold-derby-tonys.js
 * --all-historical`) and `data/awards.json` only. Does NOT depend on a
 * persisted historical-odds output file.
 *
 * For each (cycle, Big Four category):
 *   1. Pull the cached API rows
 *   2. Identify the is_winner=1 row
 *   3. Cross-check the winner's title against awards.json's tony.wins entry
 *      for that season (normalized-title match)
 *   4. Compute per-cycle stats: GD favorite (highest pct), winner rank,
 *      winner percentage, biggest gap
 *
 * Prints to stdout:
 *   - Per-category hit rate (#cycles where GD favorite == winner)
 *   - Biggest upset (winner with lowest pct)
 *   - Biggest blowout (winner with highest pct)
 *   - Calibration bins (favorite-pct ∈ [<50, 50-75, 75-90, ≥90] → empirical win rate)
 *
 * Optional --save writes a structured copy to data/analysis/gd-historical-accuracy.json.
 */

const fs = require('fs');
const path = require('path');
const { normalizeTitle } = require('./lib/title-normalization');
const {
  gdGet,
  discoverHistoricalLeagues,
  findBigFourCategoryIds,
  BIG_FOUR_GD_TO_TONY,
} = require('./lib/gd-api');

const CACHE_DIR = path.join(__dirname, '..', '.cache', 'gd');
const AWARDS_PATH = path.join(__dirname, '..', 'data', 'awards.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'analysis', 'gd-historical-accuracy.json');

function seasonKeyForCeremony(ceremonyYear) {
  const start = ceremonyYear - 1;
  const end = String(ceremonyYear).slice(2);
  return `${start}-${end}`;
}

function winnerShowFor(awards, seasonKey, tonyCategory) {
  for (const [showId, data] of Object.entries(awards)) {
    if (data.tony?.season !== seasonKey) continue;
    if (data.tony?.wins?.includes(tonyCategory)) return showId;
  }
  return null;
}

function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return Object.values(payload || {}).filter(v => v && typeof v === 'object' && 'title' in v);
}

function showIdTitleStem(showId) {
  // "the-outsiders-2024" → "the outsiders"
  // normalizeTitle treats hyphens as non-word punctuation that gets collapsed,
  // but it preserves spaces — so we convert hyphens to spaces here to keep the
  // word boundaries that the showId encodes.
  return showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
}

async function main() {
  const args = process.argv.slice(2);
  const saveOutput = args.includes('--save');

  const awardsRaw = JSON.parse(fs.readFileSync(AWARDS_PATH, 'utf8'));
  const awards = awardsRaw.shows || awardsRaw;

  const leagues = (await discoverHistoricalLeagues()).filter(lg =>
    lg.ceremonyYear >= 2013 && lg.ceremonyYear <= 2025
  );

  /** @type {Record<string, Array<{cycle, leagueId, winnerTitle, winnerPct, favoriteTitle, favoritePct, favoriteWon, rowCount, allRows, expectedWinnerShowId, winnerTitleMatches, status}>>} */
  const byCategory = {};
  const discrepancies = [];

  for (const lg of leagues) {
    const cats = await findBigFourCategoryIds(lg.leagueId);
    const seasonKey = seasonKeyForCeremony(lg.ceremonyYear);

    for (const [tonyCategory, info] of Object.entries(cats)) {
      const expectedWinnerShowId = winnerShowFor(awards, seasonKey, tonyCategory);
      if (!expectedWinnerShowId) continue; // category not awarded that season

      const apiPath = `/latest-odds-v3/${lg.leagueId}/${info.gdCatId}/combined`;
      const body = await gdGet(apiPath, { cacheDir: CACHE_DIR });
      const rows = rowsOf(body).map(r => ({
        title: r.title,
        pct: parseFloat(r.percentage) || 0,
        isWinner: Number(r.is_winner) === 1,
        gdId: r.id,
      })).sort((a, b) => b.pct - a.pct);

      if (!rows.length) continue; // empty league (e.g. 2014)

      const winnerRow = rows.find(r => r.isWinner);
      const favorite = rows[0];

      const expectedStem = showIdTitleStem(expectedWinnerShowId);
      const expectedNorm = normalizeTitle(expectedStem);
      const winnerNorm = winnerRow ? normalizeTitle(winnerRow.title) : null;
      const winnerTitleMatches = winnerNorm && (winnerNorm === expectedNorm
        || expectedNorm.includes(winnerNorm) || winnerNorm.includes(expectedNorm));

      const entry = {
        cycle: seasonKey,
        ceremonyYear: lg.ceremonyYear,
        leagueId: lg.leagueId,
        category: tonyCategory,
        nominees: rows.length,
        favoriteTitle: favorite?.title,
        favoritePct: favorite?.pct,
        favoriteIsWinner: favorite?.isWinner,
        winnerTitle: winnerRow?.title,
        winnerPct: winnerRow?.pct,
        winnerRankOneIndexed: winnerRow ? rows.indexOf(winnerRow) + 1 : null,
        expectedWinnerShowId,
        winnerTitleMatches: !!winnerTitleMatches,
        allRows: rows.map(r => ({ title: r.title, pct: r.pct, isWinner: r.isWinner })),
      };

      if (!winnerTitleMatches) {
        discrepancies.push({ cycle: seasonKey, category: tonyCategory, expected: expectedStem, gdWinner: winnerRow?.title });
      }

      (byCategory[tonyCategory] = byCategory[tonyCategory] || []).push(entry);
    }
  }

  // Per-category aggregates
  const summary = {};
  for (const [cat, entries] of Object.entries(byCategory)) {
    const valid = entries.filter(e => e.winnerTitleMatches);
    const hits = valid.filter(e => e.favoriteIsWinner).length;
    const sorted = valid.slice().sort((a, b) => a.winnerPct - b.winnerPct);
    const biggestUpset = sorted[0];
    const biggestBlowout = sorted[sorted.length - 1];

    const bins = {
      '<50%': { winners: 0, total: 0 },
      '50-75%': { winners: 0, total: 0 },
      '75-90%': { winners: 0, total: 0 },
      '≥90%': { winners: 0, total: 0 },
    };
    for (const e of valid) {
      const p = e.favoritePct;
      const bin = p < 50 ? '<50%' : p < 75 ? '50-75%' : p < 90 ? '75-90%' : '≥90%';
      bins[bin].total++;
      if (e.favoriteIsWinner) bins[bin].winners++;
    }

    summary[cat] = {
      cycles: valid.length,
      hitRate: valid.length ? hits / valid.length : 0,
      hitCount: hits,
      biggestUpset: biggestUpset && { cycle: biggestUpset.cycle, winner: biggestUpset.winnerTitle, pct: biggestUpset.winnerPct, favorite: biggestUpset.favoriteTitle, favoritePct: biggestUpset.favoritePct },
      biggestBlowout: biggestBlowout && { cycle: biggestBlowout.cycle, winner: biggestBlowout.winnerTitle, pct: biggestBlowout.winnerPct },
      calibration: bins,
    };
  }

  // Print
  console.log('=== GoldDerby Historical Tony Accuracy ===\n');
  console.log(`Cycles fetched: ${[...new Set(Object.values(byCategory).flat().map(e => e.cycle))].length}`);
  console.log(`Discrepancies (GD winner title ≠ awards.json winner): ${discrepancies.length}`);
  if (discrepancies.length) {
    for (const d of discrepancies) console.log(`  ${d.cycle} ${d.category}: GD=${d.gdWinner} expected=${d.expected}`);
  }
  console.log();

  for (const cat of ['Best Musical', 'Best Play', 'Best Revival of a Musical', 'Best Revival of a Play']) {
    const s = summary[cat];
    if (!s) { console.log(`${cat}: no data`); continue; }
    console.log(`${cat}: GD favorite won ${s.hitCount}/${s.cycles} = ${(s.hitRate * 100).toFixed(0)}%`);
    if (s.biggestUpset) console.log(`  Biggest upset: ${s.biggestUpset.cycle} — ${s.biggestUpset.winner} won at ${s.biggestUpset.pct.toFixed(1)}% (GD favorite: ${s.biggestUpset.favorite} at ${s.biggestUpset.favoritePct.toFixed(1)}%)`);
    if (s.biggestBlowout) console.log(`  Biggest blowout: ${s.biggestBlowout.cycle} — ${s.biggestBlowout.winner} at ${s.biggestBlowout.pct.toFixed(1)}%`);
    console.log(`  Calibration:`);
    for (const [bin, b] of Object.entries(s.calibration)) {
      const rate = b.total ? (b.winners / b.total * 100).toFixed(0) + '%' : '—';
      console.log(`    favorite at ${bin.padEnd(7)}: won ${b.winners}/${b.total} (${rate})`);
    }
    console.log();
  }

  if (saveOutput) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    const out = {
      _meta: {
        generatedAt: new Date().toISOString(),
        source: 'goldderby-rest-api',
        endpoint: '/wp-json/gameplay/v1/latest-odds-v3/',
        cyclesAnalyzed: [...new Set(Object.values(byCategory).flat().map(e => e.cycle))].sort(),
        discrepancyCount: discrepancies.length,
      },
      summary,
      perCategory: byCategory,
      discrepancies,
    };
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2));
    console.log(`Wrote ${OUTPUT_PATH}`);
  }

  // Exit 1 if winner-title cross-check fails for too many races
  if (discrepancies.length > 3) {
    console.error(`\nWARN: ${discrepancies.length} title mismatches between GD and awards.json. Inspect before publishing.`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('audit-gd-historical-accuracy error:', e.message);
  console.error(e.stack);
  process.exit(1);
});
