#!/usr/bin/env node
/**
 * build-we-olt-season.js
 *
 * WE historical backfill, listing-led discovery for seasons the WhatsOnStage
 * REST listings no longer cover (BRO-6343: 2015-16, 2014-15). DISCOVERY
 * ONLY, never writes shows.json.
 *
 * 1. Wayback CDX: every officiallondontheatre.co.uk show page
 *    (/london-shows/show/item<N>) captured in the season window, with its
 *    newest capture up to the end of 2019.
 * 2. Fetch each item's newest capture (raw id_ bytes, existing snapshots
 *    only; up to 3 older captures when it does not parse) and parse its
 *    dated listing (lib/olt-archive-parse.js). Parsed
 *    pages are cached in data/audit/we-historical-olt-pages.json, shared by
 *    seasons, checkpointed every 25 pages, so a rerun resumes.
 * 3. Second sources: Theatre Record A-Z titles (data/audit/
 *    we-historical-az-<season>.json, when built), Theatre Record production
 *    pages (we-historical-review-led-<season>.json), WhatsOnStage review posts,
 *    Olivier nominations.
 * 4. Candidates (lib/we-olt-candidates.js) -> data/audit/
 *    we-historical-olt-<season>.json, read by promote-historical-we.js.
 *
 * Usage:
 *   node scripts/build-we-olt-season.js --season=2015-2016 [--verbose] [--offline]
 *     --offline   skip CDX + page fetches; rebuild candidates from the cache
 *   node scripts/cloud-run-script.js scripts/build-we-olt-season.js --season=2014-2015 --print-pages > out.txt
 *   node scripts/build-we-olt-season.js --season=2014-2015 --pages-from=out.txt
 */

'use strict';

// venue-write-guard-ok: venue goes to audit files only; promote-historical-we.js sanitizes it before any shows.json write.

const fs = require('fs');
const path = require('path');
const { validateSeason, getSeasonDates } = require('./lib/we-seasons');
const { parseOltShowPage, oltItemId } = require('./lib/olt-archive-parse');
const { archiveSnapshotFetchUrl } = require('./lib/archive-snapshot-url');
const { buildOltCandidates } = require('./lib/we-olt-candidates');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `build-we-olt-season.js — West End season candidates from archived Official London Theatre listings.

Usage:
  node scripts/build-we-olt-season.js --season=YYYY-YYYY [options]

Options:
  --offline     Rebuild candidates from the page cache; no network
  --verbose     Print every candidate, not just promotable ones
  --print-pages Also print each page fetched as an OLTPAGE line (for run-script.yml,
                which keeps stdout but discards written files)
  --pages-from=<file>  Merge OLTPAGE lines from <file> into the cache and skip the
                archive crawl (when this machine cannot reach web.archive.org)
  --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const PAGES_PATH = path.join(ROOT, 'data', 'audit', 'we-historical-olt-pages.json');
const DAY_MS = 86400000;
const FETCH_DELAY_MS = Number(process.env.OLT_FETCH_DELAY_MS || 1200);
const MAX_CAPTURES_PER_ITEM = 4;
const USER_AGENT = 'BroadwayScorecardBot/1.0 (+https://broadwayscorecard.com; historical listings)';

const oltPath = season => path.join(ROOT, 'data', 'audit', `we-historical-olt-${season}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

async function get(url, { timeoutMs = 60000, retries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(5000 * attempt);
    }
  }
}

/**
 * item id -> its captures, newest first (plain show page preferred over the
 * interactive-map view of the same item); only items captured inside [from, to].
 */
async function enumerateItems(from, to) {
  // One query per year: a single from..2019 query is large enough that the
  // archive resets the connection for some seasons.
  let body = '';
  for (let y = Number(from.slice(0, 4)); y <= 2019; y++) {
    const q = 'https://web.archive.org/cdx/search/cdx?url=officiallondontheatre.co.uk/london-shows/show/item*'
      + `&from=${y === Number(from.slice(0, 4)) ? from.slice(0, 6) : `${y}01`}&to=${y}12&fl=timestamp,original&filter=statuscode:200`;
    body += (await get(q, { timeoutMs: 600000 })) || '';
    body += '\n';
  }
  const captures = new Map();
  const inWindow = new Set();
  for (const line of body.split('\n')) {
    const [ts, url] = line.trim().split(/\s+/);
    const item = oltItemId(url);
    if (!item || !/^\d{14}$/.test(ts)) continue;
    if (ts.slice(0, 8) >= from && ts.slice(0, 8) <= to) inWindow.add(item);
    if (!captures.has(item)) captures.set(item, []);
    captures.get(item).push({ url, snapshot: ts, map: /interactive-map/i.test(url) });
  }
  return [...inWindow].map(item => {
    const caps = captures.get(item).sort((a, b) => (a.map - b.map) || b.snapshot.localeCompare(a.snapshot));
    return { item, url: caps[0].url, snapshot: caps[0].snapshot, captures: caps };
  });
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const season = args.find(a => a.startsWith('--season='))?.split('=')[1];
  const verbose = args.includes('--verbose');
  const offline = args.includes('--offline');
  const printPages = args.includes('--print-pages');
  const pagesFrom = args.find(a => a.startsWith('--pages-from='))?.split('=').slice(1).join('=');
  if (!season) { console.error(USAGE); process.exit(2); }
  const check = validateSeason(season);
  if (!check.isValid) { console.error(`Invalid --season: ${check.reason}`); process.exit(2); }
  const { start, end } = getSeasonDates(season);

  const cache = readJson(PAGES_PATH, { note: 'Parsed archived Official London Theatre show pages (build-we-olt-season.js, BRO-6343).', pages: {} });
  if (pagesFrom) {
    let merged = 0, bad = 0;
    for (const line of fs.readFileSync(pagesFrom, 'utf8').split('\n')) {
      const m = /OLTPAGE (\{.*\})\s*$/.exec(line);
      if (!m) continue;
      // Captured stdout can be cut mid-line; skip what does not parse.
      let entry;
      try { entry = JSON.parse(m[1]); } catch { bad++; continue; }
      if (!entry?.item) { bad++; continue; }
      const prev = cache.pages[entry.item];
      if (prev && prev.title && (!entry.title || prev.snapshot >= entry.snapshot)) continue;
      cache.pages[entry.item] = entry;
      merged++;
    }
    writeJson(PAGES_PATH, cache);
    console.log(`Merged ${merged} page(s) from ${pagesFrom}${bad ? ` (${bad} unreadable line(s) skipped)` : ''}; cache holds ${Object.keys(cache.pages).length}.`);
  } else if (!offline) {
    // Captures from 3 months before the season to 12 months after it: a
    // production opening in the season is listed (and archived) in that span.
    const items = await enumerateItems(ymd(new Date(start.getTime() - 92 * DAY_MS)), ymd(new Date(end.getTime() + 365 * DAY_MS)));
    console.log(`OLT items captured in window: ${items.length}`);
    let fetched = 0, failed = 0;
    for (const it of items) {
      const prev = cache.pages[it.item];
      // A parsed page is kept until a newer capture appears; an unparsed one
      // (error page, redirect stub) is retried.
      if (prev && prev.title && prev.snapshot >= it.snapshot) continue;
      try {
        // Walk back through older captures until one parses as a show page.
        let entry = null;
        for (const cap of it.captures.slice(0, MAX_CAPTURES_PER_ITEM)) {
          const url = archiveSnapshotFetchUrl(cap.url.replace(/^http:\/\/([^/]+):80\//, 'http://$1/'), cap.snapshot);
          const html = url && await get(url);
          const parsed = html ? parseOltShowPage(html) : null;
          entry = { item: it.item, url: cap.url, snapshot: cap.snapshot, ...(parsed || { title: null }) };
          if (parsed) break;
          await sleep(FETCH_DELAY_MS);
        }
        cache.pages[it.item] = entry;
        if (printPages) console.log(`OLTPAGE ${JSON.stringify(entry)}`);
        fetched++;
      } catch (e) {
        failed++;
        console.warn(`  item ${it.item}: ${e.message}`);
      }
      if (fetched % 25 === 0) writeJson(PAGES_PATH, cache);
      await sleep(FETCH_DELAY_MS);
    }
    writeJson(PAGES_PATH, cache);
    console.log(`Fetched ${fetched} page(s), ${failed} failed; cache holds ${Object.keys(cache.pages).length}.`);
  }

  const az = readJson(path.join(ROOT, 'data', 'audit', `we-historical-az-${season}.json`), null);
  const azTitles = (az?.titles || []).filter(t => t.opened || t.seasonFrom);
  // Theatre Record production pages resolved by we-historical-tr-resolve.yml.
  const { reviewLedPath } = require('./lib/we-review-led-candidates');
  const trPages = (readJson(reviewLedPath(ROOT, season), null)?.lookups || []).filter(x => x.tr);
  let reviews = [];
  let oliviers = [];
  if (!offline) {
    const { fetchWosReviews } = require('./lib/wos-rest-listings');
    const { fetchOlivierCeremonyNominees } = require('./lib/olivier-ceremony-wikipedia');
    const iso = d => d.toISOString().slice(0, 10);
    reviews = await fetchWosReviews({ after: iso(new Date(start.getTime() - 30 * DAY_MS)), before: iso(new Date(end.getTime() + 120 * DAY_MS)) });
    const endYear = Number(season.split('-')[1]);
    // Olivier nominations are one optional signal: a Wikipedia outage (429)
    // only means fewer promotable rows, so warn and carry on.
    for (const year of [endYear, endYear + 1]) {
      try { oliviers.push(...(await fetchOlivierCeremonyNominees(year))); } catch (e) { console.warn(`  Olivier ${year} nominees unavailable: ${e.message}`); }
    }
  } else {
    const prev = readJson(oltPath(season), null);
    reviews = prev?.signalInputs?.reviews || [];
    oliviers = prev?.signalInputs?.oliviers || [];
  }
  console.log(`Second sources: TR A-Z dated titles ${azTitles.length}, TR production pages ${trPages.length}, WOS reviews ${reviews.length}, Olivier lines ${oliviers.length}`);

  // No silent fallback: an empty pool would mark nothing as already listed.
  const showsData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = showsData.shows || showsData;
  const candidates = buildOltCandidates({ season, pages: Object.values(cache.pages), azTitles, trPages, reviews, oliviers, shows });
  const promotable = candidates.filter(c => c.decision.promotable);
  for (const c of candidates) {
    if (!verbose && !c.decision.promotable) continue;
    console.log(`  ${c.decision.promotable ? '+' : '.'} ${c.title} | ${c.venue} | ${c.previewsStartDate || '?'} / ${c.openingDate || '?'} -> ${c.closingDate || '?'} | ${c.decision.reason}`);
  }
  const reasons = {};
  for (const c of candidates) if (!c.decision.promotable) {
    const k = c.decision.reason.replace(/:.*$/, '').replace(/\d{4}-\d{2}-\d{2}.*$/, '').trim();
    reasons[k] = (reasons[k] || 0) + 1;
  }
  console.log(`Season ${season}: ${candidates.length} West End listings, ${promotable.length} promotable`);
  console.log(`Not promotable: ${JSON.stringify(reasons)}`);
  writeJson(oltPath(season), {
    generatedAt: new Date().toISOString(),
    season,
    sources: ['official-london-theatre (wayback)', 'tr-az', 'tr-page', 'wos-review', `olivier-${season.split('-')[1]}`, `olivier-${Number(season.split('-')[1]) + 1}`],
    counts: { listings: candidates.length, promotable: promotable.length, notPromotable: reasons },
    candidates,
    signalInputs: { reviews, oliviers },
  });
  console.log(`Wrote ${path.relative(ROOT, oltPath(season))}`);
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { oltPath, enumerateItems };
