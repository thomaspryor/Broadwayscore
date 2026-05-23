#!/usr/bin/env node
/**
 * scrape-gold-derby-tonys.js — Pull Tony predictions from Gold Derby REST API
 *
 * Gold Derby exposes public WordPress REST endpoints for its prediction-hub
 * odds. No scraping or auth required — plain GET with a browser User-Agent.
 * This is why we call fetch() directly instead of lib/scraper.js (fetchPage
 * is HTML-oriented; here we want JSON).
 *
 * Endpoints used:
 *   GET /wp-json/gameplay/v1/featured-leagues/tony
 *     → list of all Tony leagues (2013–current), each with a league_post_id
 *
 *   GET /wp-json/gameplay/v1/categories-titles/{leagueId}
 *     → { data: { [categoryId]: categoryName } }
 *
 *   GET /wp-json/gameplay/v1/latest-odds-v3/{leagueId}/{categoryId}/combined
 *     → [{ id, title, related_title, votes, fraction, percentage, is_winner }]
 *
 * Two modes:
 *   pre-noms  (default before ~May 1): only "Tony Awards Nominations {year}"
 *             league is live; percentage = expert ballot share for nomination.
 *             We take pNom = percentage; pWin = pNom (weak but directionally
 *             correct — nomination frontrunners also win-frontrunners).
 *
 *   post-noms: "Tony Awards {year}" (winners) league is live. pNom = 1.0 for
 *             listed nominees; pWin = percentage from winners league.
 *
 * The script auto-detects mode by presence of the winners league.
 *
 * Usage:
 *   node scripts/scrape-gold-derby-tonys.js [--season=2026] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { validateTonyPredictions } = require('./lib/fantasy-helpers');
const {
  findTonyLeagues,
  fetchLeagueOdds,
  mergeOdds,
} = require('./lib/gd-api');

function loadShows() {
  const shows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const arr = Array.isArray(shows.shows) ? shows.shows : Object.values(shows.shows || shows);
  return arr.filter(s => s && s.id && s.title);
}

function printHelp() {
  console.log(`scrape-gold-derby-tonys.js — Pull Tony predictions from Gold Derby REST API

Usage:
  node scripts/scrape-gold-derby-tonys.js [--season=YYYY] [--dry-run]
  node scripts/scrape-gold-derby-tonys.js --year=YYYY [--no-write] [--dry-run]
  node scripts/scrape-gold-derby-tonys.js --year-range=YYYY-YYYY [--no-write]
  node scripts/scrape-gold-derby-tonys.js --all-historical [--no-write]

Flags:
  --season=YYYY        Live-cron mode: scrape current cycle (default: current).
  --year=YYYY          Historical single-cycle mode: alias for --season for one
                       past Tony cycle. Use with --no-write to avoid clobbering
                       data/tony-win-probabilities.json.
  --year-range=A-B     Historical bulk mode: scrape every cycle from A through B
                       inclusive. [coming in S3 — currently errors]
  --all-historical     Alias for --year-range=2013-2025 (canonical backfill set).
                       [coming in S3 — currently errors]
  --no-write           Skip writing data/tony-win-probabilities.json. Useful for
                       historical mode to avoid clobbering current-cycle data.
  --dry-run            Print full JSON output to stdout instead of writing file.
  --help               Print this message and exit 0.
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const seasonArg = args.find(a => a.startsWith('--season='));
  const yearArg = args.find(a => a.startsWith('--year='));
  const yearRangeArg = args.find(a => a.startsWith('--year-range='));
  const allHistorical = args.includes('--all-historical');

  if (yearRangeArg || allHistorical) {
    console.error('--year-range and --all-historical are wired in S3 — not yet implemented.');
    console.error('Run with --year=YYYY for a single historical cycle.');
    process.exit(2);
  }

  // --year is an explicit historical alias for --season; both map to the same flow.
  const seasonFromYear = yearArg ? parseInt(yearArg.split('=')[1], 10) : null;
  const seasonFromSeason = seasonArg ? parseInt(seasonArg.split('=')[1], 10) : null;
  const season = seasonFromYear ?? seasonFromSeason ?? 2026;
  const dryRun = args.includes('--dry-run');
  const noWrite = args.includes('--no-write');

  console.error(`Scraping Gold Derby Tony predictions for season ${season}...`);
  const { nominations, winners } = await findTonyLeagues(season);
  if (!nominations && !winners) {
    console.error(`No Tony leagues found for season ${season}.`);
    process.exit(1);
  }
  console.error(`  Nominations league: ${nominations ? nominations.featured_league_post_id : '(none)'}`);
  console.error(`  Winners league:     ${winners ? winners.featured_league_post_id : '(none)'}`);

  const mode = winners ? 'post-noms' : 'pre-noms';
  const hasNominations = !!winners;
  const activeLeague = winners || nominations;
  console.error(`  Mode: ${mode} (using league ${activeLeague.featured_league_post_id})`);

  const oddsByCategory = await fetchLeagueOdds(activeLeague.featured_league_post_id);
  const categoryCount = Object.keys(oddsByCategory).length;
  const rowCount = Object.values(oddsByCategory).reduce((s, r) => s + r.length, 0);
  console.error(`  Pulled ${categoryCount} categories, ${rowCount} total rows`);

  const outPath = path.join(__dirname, '..', 'data', 'tony-win-probabilities.json');
  const todayUTC = new Date().toISOString().slice(0, 10);
  let existingData = {};
  try { existingData = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}
  // Only snapshot prevDayPWin once per UTC day so hourly runs don't overwrite it
  const shouldSnapshot = existingData?._meta?.snapshotDate !== todayUTC;
  const prevShows = shouldSnapshot ? (existingData.shows || {}) : {};
  if (shouldSnapshot) {
    console.error(`  [snapshot] Taking day-over-day snapshot (first run today)`);
  } else {
    console.error(`  [snapshot] Skipping prevDay snapshot (already taken today)`);
  }

  const shows = loadShows();
  const showsOut = {};
  const personsOut = {};
  const unmatched = [];
  for (const [catName, rows] of Object.entries(oddsByCategory)) {
    mergeOdds(showsOut, personsOut, catName, rows, shows, mode, unmatched);
  }

  // Stamp prevDayPWin on each category entry (only when snapshotting)
  if (shouldSnapshot) {
    for (const [showId, showData] of Object.entries(showsOut)) {
      for (const [catName, catData] of Object.entries(showData.categories)) {
        // Prefer existing prevDayPWin (true day-ago delta); fall back to current pWin (first-ever run)
        const existingPrev = existingData.shows?.[showId]?.categories?.[catName]?.prevDayPWin;
        const currentPWin = prevShows[showId]?.categories?.[catName]?.pWin;
        const prev = existingPrev ?? currentPWin;
        if (prev != null) catData.prevDayPWin = prev;
      }
    }
  } else {
    // Carry forward existing prevDayPWin values unchanged
    for (const [showId, showData] of Object.entries(showsOut)) {
      for (const [catName, catData] of Object.entries(showData.categories)) {
        const prev = existingData.shows?.[showId]?.categories?.[catName]?.prevDayPWin;
        if (prev != null) catData.prevDayPWin = prev;
      }
    }
  }

  const output = {
    _meta: {
      source: 'goldderby',
      lastUpdated: new Date().toISOString(),
      snapshotDate: shouldSnapshot ? todayUTC : (existingData._meta?.snapshotDate ?? todayUTC),
      season,
      hasNominations,
      mode,
      leagueId: activeLeague.featured_league_post_id,
      leagueName: activeLeague.featured_league_short_name,
      categoriesFetched: categoryCount,
      matchedShowCount: Object.keys(showsOut).length,
      unmatchedRowCount: unmatched.length,
    },
    shows: showsOut,
    persons: personsOut,
  };

  const v = validateTonyPredictions(output);
  if (!v.ok) {
    console.error(`\n[validation FAILED] ${v.reason}`);
    console.error(`Stats: ${JSON.stringify(v.stats || {})}`);
    if (!dryRun) process.exit(1);
  } else {
    console.error(`\n[validation ok] ${JSON.stringify(v.stats)}`);
  }

  const totalRows = rowCount;
  const unmatchedPct = totalRows > 0 ? unmatched.length / totalRows : 0;
  if (unmatchedPct > 0.20) {
    console.error(`\n[ABORT] ${(unmatchedPct*100).toFixed(1)}% of rows unmatched (${unmatched.length}/${totalRows}). Threshold is 20%.`);
    console.error('Likely causes: shows.json schema change, Gold Derby title renames, or scraper bug.');
    if (!dryRun) process.exit(1);
  }

  console.error(`\nMatched: ${Object.keys(showsOut).length} shows`);
  console.error(`Unmatched rows: ${unmatched.length}`);
  if (unmatched.length > 0) {
    console.error('\nTop 10 unmatched:');
    for (const u of unmatched.slice(0, 10)) {
      console.error(`  ${u.category}: ${u.title}${u.related_title ? ' (' + u.related_title + ')' : ''} — ${u.percentage}`);
    }
  }

  if (dryRun) {
    console.log(JSON.stringify(output, null, 2));
    console.error(`\n--dry-run: output to stdout only`);
  } else if (noWrite) {
    console.error(`\n--no-write: skipped writing ${outPath}`);
  } else {
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
    console.error(`\nWrote ${outPath}`);
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
