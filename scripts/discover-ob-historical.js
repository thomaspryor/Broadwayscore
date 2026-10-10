#!/usr/bin/env node
/**
 * discover-ob-historical.js
 *
 * Discover Off-Broadway productions from venue archive pages (Atlantic
 * `/productions/history/`, Vineyard `/shows/...`, MCC `/tix/...`) and surface
 * the ones NOT already in shows.json.
 *
 * Why: the existing venue-listing discovery (scripts/lib/venue-listing-
 * discover.js) only scrapes each venue's current-season page. Recently
 * closed productions from these subscription houses (Atlantic Lowcountry
 * July 2025, MCC Table 17 Sep 2024, etc.) never get into shows.json
 * unless TodayTix or Lortel happens to retain them.
 *
 * Flow:
 *   1. Per venue: pull production-page URLs from the archive index (or SERP)
 *   2. For each URL, fetch the production page and parse first-preview /
 *      opening / closing dates (Atlantic/Vineyard structured; MCC less so)
 *   3. Compare title+canonicalVenue against shows.json — keep only misses
 *   4. Filter to the user-specified date window (default: opened within
 *      the past N months, --months=N)
 *   5. Write candidates to data/audit/ob-historical-candidates.json
 *   6. Print a remediation table for the user
 *
 * This script is DISCOVERY ONLY. It does not write to shows.json or call
 * gather-reviews. Promotion uses scripts/promote-ob-venue-candidates.js
 * (with --admin-promote-all once user verifies the candidate list).
 *
 * Usage:
 *   node scripts/discover-ob-historical.js --venue=atlantic
 *   node scripts/discover-ob-historical.js --venue=all --months=18
 *   node scripts/discover-ob-historical.js --venue=atlantic --dry-run
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { fetchPage } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');
const { serpCensusPreflight } = require('./lib/serp-census-preflight');
const { normalizeTitle, canonicalVenue } = require('./lib/title-match');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const OUT_PATH = path.join(ROOT, 'data', 'audit', 'ob-historical-candidates.json');

const MONTH_LONG = ['january','february','march','april','may','june','july','august','september','october','november','december'];

const USAGE = `Usage: node scripts/discover-ob-historical.js [options]

Discover Off-Broadway productions from venue archive pages and surface the
ones NOT already in shows.json. Discovery only — never writes shows.json.

Options:
  --venue=NAME    atlantic | vineyard | mcc | all (default: all)
  --months=N      Only keep productions within the last N months (default: 18)
  --limit=N       Cap production URLs scanned per venue
  --dry-run       Discover and print, but do not write the candidates file
  --verbose       Log skipped/filtered URLs
  --help, -h      Show this message`;

const args = process.argv.slice(2);
// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js):
// this script previously had no guard at all, so `--help` ran the full venue
// scan (real BD/SB/SERP calls + a real ob-historical-candidates.json write)
// instead of printing usage (found 2026-09-25 while adding the BRO-4139
// preflight — reproduced live: a `--help` invocation wrote a scraper-spend
// ledger entry before being interrupted).
if (hasHelpFlag(args)) { console.log(USAGE); process.exit(0); }
const venueArg = (args.find(a => a.startsWith('--venue=')) || '').split('=')[1] || 'all';
const monthsBack = parseInt((args.find(a => a.startsWith('--months=')) || '').split('=')[1] || '18', 10);
const limit = parseInt((args.find(a => a.startsWith('--limit=')) || '').split('=')[1] || '0', 10);
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const VENUES = {
  atlantic: {
    label: 'Atlantic Theater',
    canonicalVenue: 'atlantic theater',
    archiveUrls: [
      'https://atlantictheater.org/productions/history/',
      'https://atlantictheater.org/productions/history/2/',
      'https://atlantictheater.org/productions/history/3/',
    ],
    extractProductionUrls(html) {
      const re = /<a\s+[^>]*href="(https?:\/\/atlantictheater\.org\/production\/[a-z0-9-]+\/?)"/g;
      const urls = new Set();
      let m;
      while ((m = re.exec(html))) urls.add(m[1]);
      return [...urls];
    },
  },
  vineyard: {
    label: 'Vineyard Theatre',
    canonicalVenue: 'vineyard theatre',
    serpQueries: [
      'site:vineyardtheatre.org/shows 2024',
      'site:vineyardtheatre.org/shows 2025',
    ],
    filterUrl: (u) => /vineyardtheatre\.org\/shows\/[a-z0-9-]+\/?$/.test(u),
  },
  mcc: {
    label: 'MCC Theater',
    canonicalVenue: 'mcc theater',
    serpQueries: [
      'site:mcctheater.org/tix 2024',
      'site:mcctheater.org/tix 2025',
    ],
    filterUrl: (u) => /mcctheater\.org\/tix\/[a-z0-9-]+\/?$/.test(u),
  },
};

const EXCLUDE_TITLE_RE = [
  /gala/i, /benefit/i, /freshplay/i, /miscast/i, /wip\b/i, /works in progress/i,
  /emerging artists?/i, /reunion reading/i, /screening/i, /q&a/i, /^atlantic for kids/i,
  /master class/i, /talkback/i, /panel/i, /fundraiser/i,
];

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.shows || []);
}

function buildExistingKeys(shows) {
  const set = new Set();
  for (const s of shows) {
    if (!s.title || !s.venue) continue;
    set.add(`${normalizeTitle(s.title)}|${canonicalVenue(s.venue)}`);
  }
  return set;
}

function parseDates(html) {
  // Look for "January 30, 2024" style first.
  const longRe = new RegExp(`(${MONTH_LONG.join('|')})\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'gi');
  const longs = [];
  let m;
  while ((m = longRe.exec(html))) {
    const month = String(MONTH_LONG.indexOf(m[1].toLowerCase()) + 1).padStart(2, '0');
    const day = m[2].padStart(2, '0');
    longs.push(`${m[3]}-${month}-${day}`);
  }
  if (!longs.length) return { allDates: [], first: null, last: null };
  longs.sort();
  return { allDates: longs, first: longs[0], last: longs[longs.length - 1] };
}

function withinWindow(iso, months) {
  if (!iso) return false;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return new Date(iso) >= cutoff;
}

function titleFromUrl(url) {
  const m = url.match(/\/(?:production|tix|shows)\/([a-z0-9-]+)\/?$/);
  if (!m) return null;
  return m[1]
    .replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

async function discoverAtlantic() {
  const cfg = VENUES.atlantic;
  const urls = new Set();
  for (const archUrl of cfg.archiveUrls) {
    try {
      const r = await fetchPage(archUrl, { timeout: 25000 });
      const html = r.html || r.content || '';
      if (!html || html.length < 5000) {
        if (verbose) console.log(`  [atlantic] ${archUrl}: short (${html.length} bytes)`);
        continue;
      }
      for (const u of cfg.extractProductionUrls(html)) urls.add(u);
    } catch (e) {
      if (verbose) console.log(`  [atlantic] ${archUrl}: ${e.message}`);
    }
    await sleep(300);
  }
  return [...urls];
}

async function discoverViaSerp(cfg) {
  const urls = new Set();
  for (const q of cfg.serpQueries) {
    let results = null;
    try { results = await serpQuery(q, { nbResults: 15 }); }
    catch (e) { if (verbose) console.log(`  serp error: ${e.message}`); continue; }
    if (!results) continue;
    for (const r of results) {
      if (r.url && cfg.filterUrl(r.url)) urls.add(r.url.replace(/[?#].*$/, ''));
    }
    await sleep(600);
  }
  return [...urls];
}

async function loadProductionDates(productionUrl) {
  try {
    const r = await fetchPage(productionUrl, { timeout: 20000 });
    const html = r.html || r.content || '';
    if (!html || html.length < 3000) return { ok: false, reason: 'short-response', bytes: html.length };
    // Title: og:title > <h1> > <title>
    const og = (html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) || [])[1];
    const h1 = (html.match(/<h1[^>]*>([\s\S]{1,200}?)<\/h1>/) || [])[1] || '';
    const titleTag = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
    const title = (og || h1.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || titleTag)
      .replace(/\s*\|\s*Atlantic Theater.*$/i, '')
      .replace(/\s*\|\s*Vineyard Theatre.*$/i, '')
      .replace(/\s*\|\s*MCC Theater.*$/i, '')
      .trim();
    const dates = parseDates(html);
    return { ok: true, title, dates };
  } catch (e) {
    return { ok: false, reason: 'fetch-error', error: e.message };
  }
}

async function main() {
  const shows = loadShows();
  const existingKeys = buildExistingKeys(shows);
  const venuesToScan = venueArg === 'all' ? Object.keys(VENUES) : [venueArg];
  for (const v of venuesToScan) {
    if (!VENUES[v]) {
      console.error(`Unknown venue: ${v}. Choices: ${Object.keys(VENUES).join(',')}`);
      process.exit(2);
    }
  }

  // Precondition (BRO-4139): vineyard/mcc discovery goes entirely through
  // serpQuery (site: searches) — atlantic's archive-page scrape does not.
  // Without a key, serpQuery returns null and discoverViaSerp reads that the
  // same as "searched, found nothing" (0 production URLs). WARN once up
  // front and skip only the SERP-dependent venues, rather than writing a
  // candidates file that looks identical to a genuine zero-discovery week.
  const preflight = serpCensusPreflight(process.env, {
    // No opt-out: this caller only skips when keyless, so a switch could
    // only unlock a keyless run that silently finds nothing.
    disableVar: null,
    consequence:
      'Vineyard/MCC discovery (serpQuery site: searches) would return zero '
      + 'production URLs — indistinguishable from a genuine "nothing new" '
      + 'week. Skipping those venues; Atlantic (archive-page scrape, no SERP '
      + 'key needed) still runs.',
    // Not wired into any scheduled workflow today — dispatched manually or
    // ad hoc — so there is no env: block to point at.
    workflowHint: 'wherever this run was dispatched from (no scheduled CI workflow runs this script)',
  });
  if (!preflight.ok) console.warn(`discover-ob-historical preflight: ${preflight.reason}`);

  const allCandidates = [];
  const venuesSkipped = [];

  for (const vKey of venuesToScan) {
    const cfg = VENUES[vKey];
    console.log(`\n=== ${cfg.label} ===`);
    let productionUrls;
    if (cfg.archiveUrls) {
      productionUrls = await discoverAtlantic();
    } else if (!preflight.ok) {
      productionUrls = [];
      venuesSkipped.push(vKey);
      console.log(`  SKIPPED — no SERP key available (see preflight warning above)`);
    } else {
      productionUrls = await discoverViaSerp(cfg);
    }
    console.log(`  ${productionUrls.length} production URL(s) discovered`);
    if (limit > 0) productionUrls = productionUrls.slice(0, limit);

    for (const url of productionUrls) {
      const guessedTitle = titleFromUrl(url);
      const venueCanon = cfg.canonicalVenue;
      const key = `${normalizeTitle(guessedTitle || '')}|${venueCanon}`;
      if (existingKeys.has(key)) {
        if (verbose) console.log(`  [in shows.json] ${guessedTitle}`);
        continue;
      }
      if (EXCLUDE_TITLE_RE.some(re => re.test(guessedTitle || ''))) {
        if (verbose) console.log(`  [filtered] ${guessedTitle}`);
        continue;
      }

      const detail = await loadProductionDates(url);
      const dateFirst = detail.ok ? detail.dates.first : null;
      const dateLast = detail.ok ? detail.dates.last : null;
      const inWindow = withinWindow(dateFirst, monthsBack) || withinWindow(dateLast, monthsBack);
      const actualTitle = detail.ok ? detail.title : guessedTitle;
      const candidate = {
        venue: cfg.label,
        venueCanonical: venueCanon,
        title: actualTitle,
        slugUrl: url,
        firstDateSeen: dateFirst,
        lastDateSeen: dateLast,
        withinWindow: inWindow,
        detailOk: detail.ok,
        detailReason: detail.ok ? null : (detail.reason || 'unknown'),
      };
      const status = !detail.ok ? '⚠' : (inWindow ? '✓' : '·');
      console.log(`  ${status} ${actualTitle} | ${dateFirst || '?'} → ${dateLast || '?'}`);
      allCandidates.push(candidate);
      await sleep(300);
    }
  }

  const inWindow = allCandidates.filter(c => c.withinWindow);
  console.log('');
  console.log(`Total discovered: ${allCandidates.length}; in-window (past ${monthsBack} months): ${inWindow.length}`);
  if (inWindow.length) {
    console.log('In-window candidates:');
    for (const c of inWindow) {
      console.log(`  ${c.venue}: ${c.title} | ${c.firstDateSeen} → ${c.lastDateSeen}`);
      console.log(`    ${c.slugUrl}`);
    }
  }

  if (!dryRun && venuesSkipped.length > 0) {
    // A partial run would replace the last complete candidate list with one
    // missing whole venues (nothing downstream reads venuesSkipped), so leave
    // the file untouched; candidates found this run are printed above.
    console.warn(`Not writing ${OUT_PATH}: SERP venue(s) skipped (${venuesSkipped.join(', ')}) — previous complete result kept.`);
  } else if (!dryRun) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      filter: { venue: venueArg, monthsBack, limit: limit || null },
      counts: { total: allCandidates.length, inWindow: inWindow.length },
      venuesSkipped, // BRO-4139: SERP-dependent venues skipped this run for lack of a key — 0 candidates from these is NOT "checked, found none"
      candidates: allCandidates,
    }, null, 2));
    console.log(`Wrote ${OUT_PATH}`);
  }
}

main().catch(e => { console.error('Fatal:', e.stack || e.message); process.exit(2); });
