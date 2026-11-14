#!/usr/bin/env node
'use strict';
/**
 * BRO-6606: The Stage pass for UK hub shows under the scoreable bar.
 *
 *   node scripts/uk-stage-sitemap-match.js --sitemap=<Reviews sitemap xml> [--plan=<out.json>] [--all]
 *
 * Reads uk-regional-coverage's below-bar shows (or every hub show with --all), matches them
 * to the public Stage review sitemap (scripts/lib/uk-stage-match.js) and writes a
 * dispatch-ingest-batch plan: { "<showId>": [{ "url", "outlet": "thestage" }] }. Shows whose
 * review file already holds the URL are skipped when data/review-texts is present.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { parseSitemapEntries, matchShows } = require('./lib/uk-stage-match');
const { isUkRegionalVenue } = require('./lib/market-label');
const { isLocalOnlyShow } = require('./lib/local-market');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');
const { coverage } = require('./uk-regional-coverage');

const DATA = path.join(__dirname, '..', 'data');

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/uk-stage-sitemap-match.js --sitemap=<xml> [--plan=<out.json>] [--all]');
    return 0;
  }
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
  if (!arg('sitemap')) { console.error('--sitemap=<xml file> is required'); return 2; }
  const raw = require(path.join(DATA, 'shows.json'));
  const shows = (Array.isArray(raw) ? raw : raw.shows).filter((s) => s.category === 'regional' && isUkRegionalVenue(s.venue) && !isLocalOnlyShow(s));
  const reviews = loadReviewsWithBlog();
  const have = new Map();
  for (const r of reviews) {
    if (!r.showId) continue;
    if (!have.has(r.showId)) have.set(r.showId, { n: 0, urls: new Set() });
    const h = have.get(r.showId);
    h.n += 1;
    if (r.url) h.urls.add(r.url.replace(/\/$/, ''));
  }
  // Below the scoreable bar (what the hub page hides), not just under 3 rows: unscored rows do not count.
  const reg = require(path.join(DATA, 'outlet-registry.json'));
  const below = new Set(coverage(shows, reviews, reg.outlets || reg).belowBar.map((b) => b.id));
  const pool = argv.includes('--all') ? shows : shows.filter((s) => below.has(s.id));
  const entries = parseSitemapEntries(fs.readFileSync(arg('sitemap'), 'utf8'));
  const matches = matchShows(pool, entries);
  const plan = {};
  const rows = [];
  for (const s of pool) {
    const hits = (matches[s.id] || []).filter((m) => !(have.get(s.id) || { urls: new Set() }).urls.has(m.url.replace(/\/$/, '')));
    rows.push({ id: s.id, city: s.city, reviews: (have.get(s.id) || {}).n || 0, stage: hits.length });
    if (hits.length) plan[s.id] = hits.map((m) => ({ url: m.url, outlet: 'thestage' }));
  }
  console.log(`pool ${pool.length} shows, ${Object.keys(plan).length} with a Stage match, ${Object.values(plan).reduce((a, v) => a + v.length, 0)} URLs`);
  if (argv.includes('--verbose')) for (const r of rows.filter((x) => x.stage)) console.log(`  ${r.id} (${r.reviews} reviews) -> ${plan[r.id].map((p) => p.url.split('/').pop()).join(' | ')}`);
  if (arg('plan')) fs.writeFileSync(arg('plan'), JSON.stringify(plan, null, 2) + '\n');
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { main };
