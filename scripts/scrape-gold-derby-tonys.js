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
const { normalizeTitle, titlesMatch } = require('./lib/title-normalization');
const { validateTonyPredictions } = require('./lib/fantasy-helpers');

const GD_BASE = 'https://www.goldderby.com/wp-json/gameplay/v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function gdGet(pathSuffix) {
  const url = `${GD_BASE}${pathSuffix}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://www.goldderby.com/odds/combined-odds/broadway-2026-tony-awards-predictions/',
    },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

async function findTonyLeagues(season) {
  const search = await gdGet('/featured-leagues/tony');
  if (!search?.data || !Array.isArray(search.data)) {
    throw new Error('featured-leagues/tony returned unexpected shape');
  }
  const nomsName = `Tony Awards Nominations ${season}`;
  const winsName = `Tony Awards ${season}`;
  const nominations = search.data.find(l => l.featured_league_short_name === nomsName);
  const winners = search.data.find(l => l.featured_league_short_name === winsName);
  return { nominations, winners };
}

async function fetchLeagueOdds(leagueId) {
  const titlesRes = await gdGet(`/categories-titles/${leagueId}`);
  const categoryMap = titlesRes?.data || {};
  const categories = Object.entries(categoryMap);
  const results = {};
  for (const [catId, catName] of categories) {
    try {
      const odds = await gdGet(`/latest-odds-v3/${leagueId}/${catId}/combined`);
      results[catName] = Array.isArray(odds) ? odds : [];
    } catch (err) {
      console.error(`  [warn] category ${catId} (${catName}): ${err.message}`);
      results[catName] = [];
    }
    await new Promise(r => setTimeout(r, 150));
  }
  return results;
}

function parsePercentage(pctStr) {
  if (pctStr == null) return 0;
  const n = parseFloat(String(pctStr).replace('%', '').trim());
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n / 100));
}

function loadShows() {
  const shows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const arr = Array.isArray(shows.shows) ? shows.shows : Object.values(shows.shows || shows);
  return arr.filter(s => s && s.id && s.title);
}

function matchShow(gdTitle, gdRelatedTitle, shows) {
  // Best Musical / Play: show is in gdTitle. related_title may be empty or a
  // subtitle ("Two Strangers" + "Carry a Cake Across New York").
  // Acting / design: gdTitle is the person's name, related_title is the show.
  // Try candidates in order: title, related_title alone, composite.
  const stripBrackets = (s) => (s || '').replace(/\s*[\[\(][^\]\)]*[\]\)]\s*/g, ' ').trim();
  const candidates = [];
  if (gdTitle) candidates.push(gdTitle.trim());
  if (gdRelatedTitle) {
    candidates.push(gdRelatedTitle.trim());
    const stripped = stripBrackets(gdRelatedTitle);
    if (stripped && stripped !== gdRelatedTitle.trim()) candidates.push(stripped);
  }
  if (gdTitle && gdRelatedTitle) candidates.push(`${gdTitle.trim()} ${gdRelatedTitle.trim()}`);

  let best = null;
  for (const cand of candidates) {
    for (const s of shows) {
      if (titlesMatch(s.title, cand)) {
        if (!best) best = s;
        else if (s.openingDate && (!best.openingDate || s.openingDate > best.openingDate)) {
          best = s;
        }
      }
    }
    if (best) return best;
  }
  for (const cand of candidates) {
    const candNorm = normalizeTitle(cand);
    for (const s of shows) {
      if (normalizeTitle(s.title) === candNorm) return s;
    }
  }
  // Last-resort: strip common show-title subtitles ("Beaches, A New Musical" → "Beaches").
  const stripSubtitle = (t) => (t || '').replace(/[,:]\s*(a new musical|the musical|a musical|on broadway|the play)\b.*$/i, '').trim();
  for (const cand of candidates) {
    const candNorm = normalizeTitle(cand);
    for (const s of shows) {
      if (normalizeTitle(stripSubtitle(s.title)) === candNorm) return s;
    }
  }
  return null;
}

// GD categories where row.title is a person name, not a show title.
const PERSON_LEVEL_GD_CATS = new Set([
  'Best Actor (Musical)', 'Best Actress (Musical)',
  'Best Actor (Play)', 'Best Actress (Play)',
  'Best Featured Actor (Musical)', 'Best Featured Actress (Musical)',
  'Best Featured Actor (Play)', 'Best Featured Actress (Play)',
]);

function mergeOdds(showsOut, personsOut, catName, oddsRows, shows, mode, unmatched) {
  const isPersonLevel = PERSON_LEVEL_GD_CATS.has(catName);
  for (const row of oddsRows) {
    const matched = matchShow(row.title, row.related_title, shows);
    if (!matched) {
      unmatched.push({ category: catName, title: row.title, related_title: row.related_title, percentage: row.percentage });
      continue;
    }
    const showId = matched.id;
    if (!showsOut[showId]) {
      showsOut[showId] = { title: matched.title, goldDerbyId: row.id, categories: {} };
    }
    const p = parsePercentage(row.percentage);

    // For person-level categories, store individual odds keyed by person name.
    // Show-level entry gets max pWin as a fallback for unmatched lookups.
    if (isPersonLevel && row.title && row.title !== row.related_title) {
      if (!personsOut[row.title]) personsOut[row.title] = {};
      personsOut[row.title][catName] = { pWin: p, votes: row.votes || 0 };
    }

    const existing = showsOut[showId].categories[catName] || {};
    const prevPWin = existing.pWin ?? 0;
    const prevVotes = existing.votes ?? 0;
    if (prevPWin >= p) continue; // keep max pWin for show-level fallback
    if (mode === 'pre-noms') {
      showsOut[showId].categories[catName] = {
        ...existing, pNom: p, pWin: p,
        votes: (row.votes || 0) + prevVotes, gdNomineeId: row.id,
      };
    } else {
      showsOut[showId].categories[catName] = {
        ...existing, pNom: 1.0, pWin: p,
        votes: (row.votes || 0) + prevVotes, gdNomineeId: row.id,
      };
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const seasonArg = args.find(a => a.startsWith('--season='));
  const season = seasonArg ? parseInt(seasonArg.split('=')[1], 10) : 2026;
  const dryRun = args.includes('--dry-run');

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

  const shows = loadShows();
  const showsOut = {};
  const personsOut = {};
  const unmatched = [];
  for (const [catName, rows] of Object.entries(oddsByCategory)) {
    mergeOdds(showsOut, personsOut, catName, rows, shows, mode, unmatched);
  }

  const output = {
    _meta: {
      source: 'goldderby',
      lastUpdated: new Date().toISOString(),
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

  const outPath = path.join(__dirname, '..', 'data', 'tony-win-probabilities.json');
  if (dryRun) {
    console.log(JSON.stringify(output, null, 2));
    console.error(`\n--dry-run: output to stdout only`);
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
