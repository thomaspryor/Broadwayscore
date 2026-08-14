#!/usr/bin/env node
/**
 * discover-historical-shows-we.js
 *
 * WE historical pilot S1 (plan v2.2): enumerate West End productions for a
 * given season that are NOT already in shows.json. Follows the OB historical
 * pattern (discover-ob-historical.js / promote-ob-historical.js) — this
 * script is DISCOVERY ONLY, it never writes shows.json. It writes candidates
 * to data/audit/we-historical-candidates.json for human review, then
 * promote-historical-we.js writes the reviewed subset into shows.json.
 *
 * Theatre Record's production index would be the ideal primary discovery
 * source (comprehensive, cheap), but its extraction requires an authenticated
 * Playwright session (see scripts/extract-theatre-record.js) that only runs
 * in CI with the TR_EMAIL/TR_PASSWORD secrets — this script can't drive that
 * itself. Wikipedia's per-season "YYYY–YY West End theatre season" articles
 * are a real, freely-fetchable source (verified live 2026-08-11) and are
 * wired here as SOURCES.wikipedia. Additional sources (Olivier eligibility
 * lists, OLT) are stubbed — see SOURCES below — so the corroboration bar
 * (scripts/lib/we-historical-corroboration.js, ≥2 independent sources) is
 * honest about what's actually wired: with one live source, nothing
 * auto-corroborates, and every candidate needs human review before
 * promote-historical-we.js can accept it (plan's "hand-check the first 10
 * candidates" probe gate).
 *
 * Usage:
 *   node scripts/discover-historical-shows-we.js --season=2024-2025
 *   node scripts/discover-historical-shows-we.js --season=2024-2025 --verbose
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { fetchPage } = require('./lib/scraper');
const { normalizeTitle } = require('./lib/title-match');
const { venuesMatch } = require('./lib/deduplication');
const { validateSeason, getSeasonDates, isDateInSeason } = require('./lib/we-seasons');
const { isCorroborated } = require('./lib/we-historical-corroboration');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `discover-historical-shows-we.js — Enumerate WE productions for a season not already in shows.json. Writes candidates only.

Usage:
  node scripts/discover-historical-shows-we.js --season=YYYY-YYYY [options]

Options:
  --verbose     Print per-candidate parse detail
  --help, -h    print this usage and exit
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const args = process.argv.slice(2);
const seasonArg = args.find(a => a.startsWith('--season='))?.split('=')[1];
const verbose = args.includes('--verbose');

if (!seasonArg) {
  console.error('Usage: node scripts/discover-historical-shows-we.js --season=YYYY-YYYY');
  process.exit(2);
}
const seasonCheck = validateSeason(seasonArg);
if (!seasonCheck.isValid) {
  console.error(`Invalid --season: ${seasonCheck.reason}`);
  process.exit(2);
}

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const OUT_PATH = path.join(ROOT, 'data', 'audit', 'we-historical-candidates.json');

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows || data;
  return Array.isArray(shows) ? shows : Object.values(shows);
}

function wikipediaSeasonUrl(season) {
  const [startYear, endYear] = season.split('-');
  const shortEnd = endYear.slice(2);
  // en dash between the two year halves, URL-encoded.
  return `https://en.wikipedia.org/wiki/${startYear}%E2%80%93${shortEnd}_West_End_theatre_season`;
}

/**
 * Best-effort extraction of {title, venue, openingDate} triples from a WE
 * season Wikipedia article. These articles are hand-edited prose/lists with
 * no consistent machine-readable structure across years, so this looks for
 * the most durable signal: an internal wiki link (the production's own
 * article, or a redirect) followed within the same list item / paragraph by
 * "at the X Theatre" and a date. Entries where a venue can't be found are
 * kept with venue:null (dedup/corroboration will naturally fail closed on
 * those rather than guessing).
 */
function parseWikipediaSeasonPage(html) {
  const results = [];
  // Wikipedia list items and short paragraphs containing a wikilink + "at the ... Theatre"
  const blockRe = /<(?:li|p)[^>]*>([\s\S]{1,600}?)<\/(?:li|p)>/g;
  let block;
  while ((block = blockRe.exec(html))) {
    const chunk = block[1];
    const linkMatch = chunk.match(/<a\s+href="\/wiki\/[^"]+"\s+title="([^"]+)">([^<]+)<\/a>/);
    if (!linkMatch) continue;
    const linkText = linkMatch[2].replace(/&amp;/g, '&').trim();
    // Skip obvious non-title links (venues, people, months) — real production
    // titles are the FIRST wikilink in the block in these articles' convention.
    if (/^(?:January|February|March|April|May|June|July|August|September|October|November|December)$/.test(linkText)) continue;

    const venueMatch = chunk.match(/at the ([A-Z][A-Za-z0-9''\s&.-]{2,50}?(?:Theatre|Theater))/);
    const dateMatch = chunk.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/);

    let openingDate = null;
    if (dateMatch) {
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const mm = String(months.indexOf(dateMatch[2]) + 1).padStart(2, '0');
      const dd = dateMatch[1].padStart(2, '0');
      openingDate = `${dateMatch[3]}-${mm}-${dd}`;
    }

    results.push({
      title: linkText,
      venue: venueMatch ? venueMatch[1].trim() : null,
      openingDate,
    });
  }
  return results;
}

async function fetchWikipediaSource(season) {
  const url = wikipediaSeasonUrl(season);
  let html;
  try {
    const r = await fetchPage(url, { timeout: 20000 });
    html = r.html || r.content || '';
  } catch (e) {
    console.log(`  Wikipedia fetch failed: ${e.message}`);
    return [];
  }
  if (!html || html.length < 2000) {
    console.log(`  Wikipedia page short/missing (${html.length} bytes) — season page may not exist yet`);
    return [];
  }
  const parsed = parseWikipediaSeasonPage(html);
  return parsed
    .filter(p => p.venue) // no corroboration value without a venue to match on
    .map(p => ({ source: 'wikipedia', ...p }));
}

// Additional independent validation sources per plan v2.2 S1. Not yet wired —
// each returns [] with a one-time warning so isCorroborated's ≥2-source bar
// stays honest (nothing auto-corroborates on Wikipedia alone).
async function fetchOlivierEligibilitySource(_season) {
  console.log('  [olivier-eligibility] not yet implemented — 0 rows (see plan v2.2 S1)');
  return [];
}
async function fetchOltSource(_season) {
  console.log('  [olt] not yet implemented — 0 rows (see plan v2.2 S1)');
  return [];
}

const SOURCES = {
  wikipedia: fetchWikipediaSource,
  'olivier-eligibility': fetchOlivierEligibilitySource,
  olt: fetchOltSource,
};

// {title, venue} match via venuesMatch(), not title-match.js's canonicalVenue()
// equality — canonicalVenue's fallback for a venue outside VENUE_ALIASES is
// just the lowercased FIRST WORD, so two unrelated venues sharing a leading
// word ("The X") would collapse and silently drop a genuinely new candidate
// before any human ever sees it (BRO-243).
function buildExistingList(shows) {
  return shows.filter(s => s.title && s.venue).map(s => ({ title: s.title, venue: s.venue }));
}

function findMatch(list, title, venue) {
  const norm = normalizeTitle(title);
  return list.find(s => normalizeTitle(s.title) === norm && venuesMatch(s.venue, venue)) || null;
}

async function main() {
  const shows = loadShows();
  const existingList = buildExistingList(shows);
  const { start, end } = getSeasonDates(seasonArg);

  console.log(`Discovering WE productions for season ${seasonArg} (${start.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)})`);
  console.log(`Sources: ${Object.keys(SOURCES).join(', ')}`);

  const allRecords = [];
  for (const [name, fetcher] of Object.entries(SOURCES)) {
    console.log(`\n=== ${name} ===`);
    const rows = await fetcher(seasonArg);
    console.log(`  ${rows.length} row(s)`);
    allRecords.push(...rows);
  }

  // Build one candidate per distinct title+venue across all sources. A flat
  // array + findMatch() scan (not a canonicalVenue-keyed Map) for the same
  // reason as buildExistingList/findMatch above.
  const byKey = [];
  for (const r of allRecords) {
    if (!findMatch(byKey, r.title, r.venue)) {
      byKey.push({ title: r.title, venue: r.venue, openingDate: r.openingDate });
    }
  }

  const candidates = [];
  for (const base of byKey) {
    if (findMatch(existingList, base.title, base.venue)) {
      if (verbose) console.log(`  [in shows.json] ${base.title}`);
      continue;
    }
    // A parsed date outside the requested season window means either a
    // parser mismatch or a boundary-adjacent transfer from an adjacent
    // season — don't silently tag it with the wrong season (promote-
    // historical-we.js trusts `candidate.season` verbatim to build the
    // show id). A missing date can't be checked either way and is left to
    // isCorroborated (which now fails closed on missing dates too).
    if (base.openingDate && !isDateInSeason(base.openingDate, seasonArg)) {
      console.log(`  ✗ ${base.title} | ${base.venue} | ${base.openingDate} — outside ${seasonArg} window, skipped`);
      continue;
    }
    const corroboration = isCorroborated(
      { ...base, discoverySource: null },
      allRecords,
    );
    const candidate = {
      title: base.title,
      venue: base.venue,
      openingDate: base.openingDate,
      season: seasonArg,
      corroborated: corroboration.corroborated,
      agreeingSources: corroboration.agreeingSources,
    };
    const status = corroboration.corroborated ? '✓' : '·';
    console.log(`  ${status} ${base.title} | ${base.venue} | ${base.openingDate || '?'} | sources: ${corroboration.agreeingSources.join(',') || 'none'}`);
    candidates.push(candidate);
  }

  console.log('');
  const corroboratedCount = candidates.filter(c => c.corroborated).length;
  console.log(`Total candidates: ${candidates.length}; corroborated (≥2 independent sources): ${corroboratedCount}`);

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    season: seasonArg,
    sources: Object.keys(SOURCES),
    counts: { total: candidates.length, corroborated: corroboratedCount },
    candidates,
  }, null, 2));
  console.log(`Wrote ${OUT_PATH}`);
}

main().catch(e => { console.error('Fatal:', e.stack || e.message); process.exit(2); });
