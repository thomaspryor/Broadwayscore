#!/usr/bin/env node
/**
 * build-we-season-reference.js (BRO-6450)
 *
 * Builds the West End season reference list the season audit checks the site
 * against: every production that opened at a SOLT West End house in a Sep-Aug
 * season, from at least two independent sources. Writes
 * data/audit/we-season-reference/<season>.json; never touches shows.json.
 *
 * Sources (lib/we-season-reference.js has the rules):
 *   theatricalia  venue production histories (theatricalia.com/place/.../past),
 *                 cached in data/audit/we-season-reference/theatricalia-cache.json
 *   tr-az         Theatre Record A-Z titles (data/audit/we-historical-az-<season>.json)
 *   olt           archived Official London Theatre listings (we-historical-olt-<season>.json)
 *   wos           WhatsOnStage listing candidates (we-historical-candidates-<season>.json)
 *   guardian      Guardian theatre reviews near the entry's start (review archive pages,
 *                 cached in data/audit/we-season-reference/guardian-reviews.json)
 *   wikipedia     the venue's Wikipedia article (production history sections),
 *                 cached in data/audit/we-season-reference/wikipedia-cache.json
 * An entry counts toward the reference list only when two sources carry it.
 *
 * Usage:
 *   node scripts/build-we-season-reference.js --season=2013-2014 [--offline] [--refresh]
 *     --offline  caches only, no fetches
 *     --refresh  refetch Theatricalia and Wikipedia even when cached
 */

'use strict';
// venue-write-guard-ok: venues go into the audit reference list only, never shows.json.

const fs = require('fs');
const path = require('path');
const { validateSeason } = require('./lib/we-seasons');
const { parseTheatricaliaList, buildSeasonReference } = require('./lib/we-season-reference');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `build-we-season-reference.js — West End season reference list (BRO-6450).

Usage:
  node scripts/build-we-season-reference.js --season=YYYY-YYYY [--offline] [--refresh]

Options:
  --offline   caches only, no fetches
  --refresh   Refetch Theatricalia venue histories and Wikipedia articles even when cached
  --help, -h  print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'audit', 'we-season-reference');
const CACHE = path.join(DIR, 'theatricalia-cache.json');
const WIKI_CACHE = path.join(DIR, 'wikipedia-cache.json');
const UA = 'BroadwayScorecard/1.0 (season reference research; https://broadwayscorecard.com)';
// Venue histories are newest first; stop paging once a page is wholly older than this.
const OLDEST_NEEDED = '2010-08-01';
const MAX_PAGES = 20;
// One Guardian pass covers every season backfilled so far (2010-11 .. 2016-17; BRO-6503).
const GUARDIAN_FROM = '2010-08-01';
const GUARDIAN_TO = '2018-01-31';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
    } catch { /* retry */ }
    await sleep(2000 * (i + 1));
  }
  throw new Error(`fetch failed: ${url}`);
}

async function placeHistory(placePath) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await get(`https://theatricalia.com${placePath}/past${page > 1 ? `?page=${page}` : ''}`);
    if (!html) break;
    const list = parseTheatricaliaList(html);
    rows.push(...list);
    const dated = list.filter(e => e.start);
    if (!list.length || (dated.length && dated.every(e => e.start < OLDEST_NEEDED))) break;
    if (!html.includes(`?page=${page + 1}`)) break;
    await sleep(500);
  }
  return rows;
}

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };

function corroboratorsFor(season) {
  const audit = path.join(ROOT, 'data', 'audit');
  const out = [];
  const az = readJson(path.join(audit, `we-historical-az-${season}.json`), null);
  if (az) out.push({ name: 'tr-az', titles: (az.titles || []).map(t => t.title) });
  const olt = readJson(path.join(audit, `we-historical-olt-${season}.json`), null);
  if (olt) out.push({ name: 'olt', titles: (olt.candidates || []).map(c => c.title) });
  const wos = readJson(path.join(audit, `we-historical-candidates-${season}.json`), null);
  if (wos) out.push({ name: 'wos', titles: (wos.candidates || []).map(c => c.title) });
  return out;
}

// Guardian theatre reviews (theguardian.com/stage/theatre+tone/reviews, newest
// first): headline title + publish date, for every page dated in [from, to].
const GUARDIAN = path.join(DIR, 'guardian-reviews.json');
const MONTH_ABBR = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseGuardianPage(html) {
  const out = [];
  const re = /href="\/stage\/(\d{4})\/([a-z]{3})\/(\d{2})\/[^"#]+" [^>]*aria-label="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const headline = m[4].replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');
    const t = headline.match(/^(.+?)\s+review\b/i);
    if (!t) continue;
    out.push({ date: `${m[1]}-${String(MONTH_ABBR.indexOf(m[2]) + 1).padStart(2, '0')}-${m[3]}`, title: t[1].trim(), headline });
  }
  return out;
}
async function guardianPage(n) { return parseGuardianPage(await get(`https://www.theguardian.com/stage/theatre+tone/reviews?page=${n}`) || ''); }
async function buildGuardian(from, to) {
  const cache = readJson(GUARDIAN, { from: null, to: null, reviews: [] });
  if (cache.from && cache.from <= from && cache.to >= to) return cache.reviews;
  // Binary search for the first page whose newest review is on or before `to`.
  let lo = 1;
  let hi = 900;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const rows = await guardianPage(mid);
    if (!rows.length || rows[0].date <= to) hi = mid; else lo = mid + 1;
  }
  const seen = new Set();
  const reviews = [];
  for (let n = Math.max(1, lo - 1); n < lo + 600; n++) {
    const rows = await guardianPage(n);
    if (!rows.length) break;
    for (const r of rows) {
      const k = `${r.date}|${r.headline}`;
      if (r.date >= from && r.date <= to && !seen.has(k)) { seen.add(k); reviews.push({ date: r.date, title: r.title }); }
    }
    if (rows[rows.length - 1].date < from) break;
    if (n % 25 === 0) process.stderr.write(`guardian page ${n} ${rows[rows.length - 1].date}\n`);
    await sleep(250);
  }
  const out = { from, to, fetchedAt: new Date().toISOString().slice(0, 10), source: 'https://www.theguardian.com/stage/theatre+tone/reviews', reviews };
  fs.writeFileSync(GUARDIAN, `${JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n{')}\n`);
  return reviews;
}

const wikiPlain = raw => String(raw || '').replace(/<ref[\s\S]*?(<\/ref>|\/>)/g, ' ').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'{2,}/g, '');

async function main() {
  const args = process.argv.slice(2);
  const season = args.find(a => a.startsWith('--season='))?.split('=')[1];
  if (!season || !validateSeason(season).isValid) { console.error(USAGE); process.exit(2); }
  const offline = args.includes('--offline');
  const refresh = args.includes('--refresh');
  const { venues } = readJson(path.join(DIR, 'venues.json'));
  const cache = readJson(CACHE, { fetchedAt: {}, places: {} });

  for (const v of venues) {
    for (const p of v.theatricalia) {
      if (cache.places[p] && !refresh) continue;
      if (offline) continue;
      process.stderr.write(`theatricalia ${p}\n`);
      cache.places[p] = (await placeHistory(p)).filter(e => !e.start || e.start >= OLDEST_NEEDED);
      cache.fetchedAt[p] = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(CACHE, `${JSON.stringify(cache, null, 1)}\n`);
    }
  }

  // Venue articles are cached like the Theatricalia pages, so a rate-limited
  // fetch cannot silently drop the wikipedia source from a rebuilt list.
  const wikiCache = readJson(WIKI_CACHE, { fetchedAt: {}, pages: {} });
  const pages = [...new Set(venues.map(v => v.wikipedia).filter(Boolean))];
  const failed = [];
  for (const page of pages) {
    if (offline || (wikiCache.pages[page] && !refresh)) continue;
    try {
      wikiCache.pages[page] = wikiPlain(await get(`https://en.wikipedia.org/wiki/${page}?action=raw`));
      wikiCache.fetchedAt[page] = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(WIKI_CACHE, `${JSON.stringify(wikiCache, null, 1)}\n`);
    } catch (e) { failed.push(page); process.stderr.write(`wikipedia ${page}: ${e.message}\n`); }
    await sleep(1500);
  }
  if (failed.length) { console.error(`Wikipedia fetch failed for ${failed.join(', ')}; rerun (cached pages are kept).`); process.exit(1); }
  const wikipedia = {};
  for (const v of venues) if (wikiCache.pages[v.wikipedia]) wikipedia[v.venue] = wikiCache.pages[v.wikipedia];

  const venueEntries = venues.map(v => ({ venue: v.venue, entries: v.theatricalia.flatMap(p => cache.places[p] || []) }));
  const corroborators = corroboratorsFor(season);
  const guardian = offline ? readJson(GUARDIAN, { reviews: [] }).reviews : await buildGuardian(GUARDIAN_FROM, GUARDIAN_TO);
  if (guardian.length) corroborators.push({ name: 'guardian', titles: guardian });
  const { entries, excluded } = buildSeasonReference({ season, venueEntries, corroborators, wikipedia });
  const reference = entries.filter(e => e.corroborated);
  const out = {
    generatedAt: new Date().toISOString(),
    season,
    issue: 'BRO-6450',
    definition: 'Productions whose first performance falls in the Sep-Aug season at a SOLT West End house as data/west-end-venues.json defines it (NT Olivier/Lyttelton/Dorfman, Old Vic and Royal Court included; Barbican and Off-West End houses not), with a run of 14+ days. An entry is in the reference list when two independent sources carry it.',
    sources: ['theatricalia (venue histories)', ...corroborators.map(c => c.name), ...(Object.keys(wikipedia).length ? ['wikipedia (venue articles)'] : [])],
    counts: { reference: reference.length, theatricaliaOnly: entries.length - reference.length, excludedShortRuns: excluded.length },
    reference,
    uncorroborated: entries.filter(e => !e.corroborated),
    excluded,
  };
  fs.writeFileSync(path.join(DIR, `${season}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`${season}: reference ${reference.length}, theatricalia-only ${out.counts.theatricaliaOnly}, short runs excluded ${excluded.length}`);
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
  main().catch(e => { console.error(e); process.exit(1); });
}
