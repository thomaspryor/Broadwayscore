#!/usr/bin/env node
'use strict';
/**
 * BRO-7683: which productions BroadwayWorld reviewed in each launched US city hub have no
 * shows.json row. Reads https://www.broadwayworld.com/<bwwRegion>/local-reviews/?page=N
 * (data/city-hubs.json `bwwRegion`) back to --days, through fetchPage.
 *
 *   node scripts/bww-regional-coverage.js [--city=<hub slug>] [--days=60] [--max-pages=6] [--json] [--strict]
 *
 * Writes data/audit/bww-regional-coverage.json (per hub: counts + every missing review).
 * Exit 0, or 1 with --strict when any hub has a missing production. A page that cannot be
 * fetched is reported per hub (`fetchErrors`), never counted as coverage.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { parseLocalReviews, classifyReview, displayTitle, sameHouse } = require('./lib/bww-local-reviews');
const { normalizeTitle } = require('./lib/title-match');

// Per-review verdicts from scripts/bww-regional-add-plan.js (community / not theatre / touring ...), so a review
// the add step already declined is not reported as missing again.
const DECISIONS = path.join(__dirname, '..', 'data', 'audit', 'bww-regional-decisions.json');
const loadDecisions = (file = DECISIONS) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).reviews || {}; } catch { return {}; } };

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };

/** Hubs to audit, with their BWW region and tour-house patterns. */
function hubsToAudit(registry, only) {
  return Object.entries(registry.hubs)
    .filter(([slug, h]) => h.launched === true && h.bwwRegion && (!only || slug === only || h.bwwRegion === only))
    .map(([slug, h]) => ({
      metro: slug,
      region: h.bwwRegion,
      tourHouses: ((h.tic && h.tic.tourHouses) || []).map((p) => new RegExp(p, 'i')),
    }));
}

async function auditHub(hub, { shows, fetchHtml, since, maxPages, decisions = {} }) {
  const reviews = new Map();
  const fetchErrors = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://www.broadwayworld.com/${hub.region}/local-reviews/${page > 1 ? `?page=${page}` : ''}`;
    let html = '';
    try { html = await fetchHtml(url); } catch (e) { fetchErrors.push(`${url}: ${String(e.message || e).slice(0, 120)}`); break; }
    const rows = parseLocalReviews(html, hub.region);
    if (!rows.length) { if (page === 1) fetchErrors.push(`${url}: no reviews parsed`); break; }
    let fresh = 0;
    for (const r of rows) if (!r.date || r.date >= since) { reviews.set(r.url, r); fresh++; }
    if (!fresh) break;
  }
  const out = { metro: hub.metro, region: hub.region, since, reviews: reviews.size, covered: 0, coveredTour: 0, excluded: 0, declined: 0, tourHouse: 0, missing: [], fetchErrors };
  // One production can carry several reviews (two critics): report it once, keyed on title + venue.
  const seen = new Map();
  const byId = new Map(shows.map((s) => [s.id, s]));
  for (const r of [...reviews.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    let c = classifyReview(r, { shows, metro: hub.metro, tourHouses: hub.tourHouses, decisions });
    // Same title, another company: the covering row was added from a different review on this listing that names a
    // different theatre (Chicago Shakespeare's Winter's Tale "covered" Modern Archaic's). That is a second production.
    // Flag it only when nothing ties it to the row: no earlier ruling on this URL, the row's own venue is another
    // house, and every evidence review on the listing names another house (critics name one house differently).
    const ruled = decisions && decisions[r.url] && decisions[r.url].decision && decisions[r.url].decision !== 'add';
    if (c.status === 'covered' && r.venue && !ruled) {
      const row = byId.get(c.showId);
      const others = row ? (row.evidenceUrls || []).map((u) => reviews.get(u)).filter((o) => o && o.url !== r.url && o.venue) : [];
      if (others.length && !(row.venue && sameHouse(r.venue, row.venue)) && others.every((o) => !sameHouse(o.venue, r.venue))) {
        c = { status: 'missing' };
      }
    }
    if (c.status === 'covered') out.covered++;
    else if (c.status === 'covered-tour') out.coveredTour++;
    else if (c.status === 'excluded') out.excluded++;
    else if (c.status === 'declined') out.declined++;
    else if (c.status === 'tour-house') out.tourHouse++;
    else {
      // Title + venue: two companies' productions of one title are two rows (BRO-7683 review).
      const key = normalizeTitle(r.title) ? `${normalizeTitle(r.title)}|${normalizeTitle(r.venue || '')}` : r.url;
      if (seen.has(key)) { seen.get(key).urls.push(r.url); continue; }
      const row = { title: displayTitle(r.title), venue: r.venue, headline: r.headline, firstReview: r.date, urls: [r.url] }; // venue-write-guard-ok: audit report row, never written to shows.json
      seen.set(key, row);
      out.missing.push(row);
    }
  }
  return out;
}

async function main() {
  const days = Number(arg('days', 60));
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'city-hubs.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const hubs = hubsToAudit(registry, arg('city', null));
  if (!hubs.length) { console.error('no launched hub with bwwRegion in data/city-hubs.json'); return 2; }
  const { fetchPage, cleanup } = require('./lib/scraper');
  const fetchHtml = async (url) => ((await fetchPage(url, { skipVerify: true })) || {}).content || '';
  const report = { on: new Date().toISOString().slice(0, 10), days, hubs: [] };
  const decisions = loadDecisions();
  try {
    for (const hub of hubs) report.hubs.push(await auditHub(hub, { shows, fetchHtml, since, maxPages: Number(arg('max-pages', 6)), decisions }));
  } finally {
    if (cleanup) await cleanup().catch(() => {});
  }
  fs.mkdirSync(path.join(ROOT, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'audit', 'bww-regional-coverage.json'), JSON.stringify(report, null, 1) + '\n');
  if (flag('json')) console.log(JSON.stringify(report, null, 1));
  else {
    for (const h of report.hubs) {
      console.log(`${h.metro}: ${h.reviews} reviews since ${h.since}; covered ${h.covered}, tour ${h.coveredTour}, tour-house ${h.tourHouse}, excluded ${h.excluded}, declined ${h.declined}, MISSING ${h.missing.length}${h.fetchErrors.length ? `, fetch errors ${h.fetchErrors.length}` : ''}`);
      for (const m of h.missing) console.log(`  - ${m.title} | ${m.venue} | ${m.firstReview} | ${m.urls[0]}`);
      for (const e of h.fetchErrors) console.log(`  ! ${e}`);
    }
  }
  const missing = report.hubs.reduce((a, h) => a + h.missing.length, 0);
  return flag('strict') && missing ? 1 : 0;
}

if (require.main === module) {
  const { exitFlushed } = require('./lib/exit-flushed');
  main().then((c) => exitFlushed(c), (e) => { console.error(e); exitFlushed(3); });
}
module.exports = { hubsToAudit, auditHub, loadDecisions, DECISIONS };
