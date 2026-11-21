#!/usr/bin/env node
'use strict';
/**
 * BRO-6710: per-show SERP sweep for UK hub shows still under the scoreable bar.
 *
 *   node scripts/uk-serp-sweep.js [--ids=a,b] [--limit=N] [--deep] [--plan=<out.json>] [--verbose]
 *
 * Two natural-language queries per show ("Title" venue year review; "Title" city review), which
 * return Guardian, Reviews Hub, Northern Arts Review, etc. where generic site: queries do not.
 * Candidates go through scripts/lib/uk-serp-sweep.js; the plan is { showId: [{url, outlet}] } for
 * scripts/dispatch-ingest-batch.js. ~5 SERP credits per query. Read-only.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { serpQuery } = require('./lib/url-discovery');
const { resolveRegisteredOutlet, looksLikeAggregationOrReaction } = require('./lib/regional-serp-discovery');
const { isNonReviewUrl } = require('./lib/serp-non-review-url');
const { urlLooksLikeReview } = require('./lib/review-guards');
const { pickForShow } = require('./lib/uk-serp-sweep');
const { urlKey } = require('./lib/outlet-feed-reconcile');
const { heldUrlIndex } = require('./uk-regional-census-match');
const { coverage } = require('./uk-regional-coverage');
const { isUkRegionalVenue } = require('./lib/market-label');
const { isLocalOnlyShow } = require('./lib/local-market');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');

const DATA = path.join(__dirname, '..', 'data');

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/uk-serp-sweep.js [--ids=a,b] [--limit=N] [--deep] [--plan=<out.json>] [--verbose]');
    return 0;
  }
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
  const raw = require(path.join(DATA, 'shows.json'));
  const hub = (Array.isArray(raw) ? raw : raw.shows).filter((s) => s.category === 'regional' && isUkRegionalVenue(s.venue) && !isLocalOnlyShow(s));
  const reg = require(path.join(DATA, 'outlet-registry.json'));
  const below = new Map(coverage(hub, loadReviewsWithBlog(), reg.outlets || reg).belowBar.map((b) => [b.id, b.reviews]));
  const ids = arg('ids') ? new Set(arg('ids').split(',')) : null;
  let pool = hub.filter((s) => (ids ? ids.has(s.id) : below.has(s.id)));
  if (arg('limit')) pool = pool.slice(0, Number(arg('limit')));
  // review-texts is a private checkout (absent in worktrees), so reviews.json is the held set too.
  const held = heldUrlIndex(hub.map((s) => s.id));
  for (const r of loadReviewsWithBlog()) {
    const set = held.get(r.showId);
    if (!set) continue;
    if (r.url) set.add(urlKey(r.url));
    if (r.outletId) set.add(`outlet:${r.outletId}`);
  }
  const plan = {};
  let serpFailed = 0;
  for (const s of pool) {
    const house = String(s.venue || '').split(',')[0].trim();
    const city = String(s.venue || '').split(',')[1]?.trim() || '';
    const year = String(s.openingDate || '').slice(0, 4);
    const results = [];
    const queries = [{ q: `"${s.title}" ${house} ${year} review` }, { q: `"${s.title}" ${city} theatre review` }];
    // --deep: an unquoted query and the second result page of the first, for shows the plain pass left under the bar.
    if (argv.includes('--deep')) queries.push({ q: `${s.title} ${house} review` }, { q: queries[0].q, page: 1 });
    for (const { q, page } of queries) {
      const r = await serpQuery(q, { nbResults: 10, skipProviders: ['scrapingbee'], page });
      if (r === null || r === undefined) serpFailed++;
      else results.push(...r);
    }
    const ctx = { resolve: resolveRegisteredOutlet, reject: (u, t, st) => isNonReviewUrl(u) || !urlLooksLikeReview(u, st) || looksLikeAggregationOrReaction(u, t, st), heldKeys: held.get(s.id) || new Set(), urlKey };
    const picks = pickForShow(s, results, ctx);
    if (picks.length) plan[s.id] = picks;
    if (argv.includes('--verbose')) console.log(`${s.id} (${below.get(s.id)} held): ${results.length} results -> ${picks.map((p) => `${p.outlet}:${p.url}`).join(' | ') || 'none'}`);
  }
  if (serpFailed) console.error(`WARNING: ${serpFailed} SERP queries returned nothing (provider failure); a missing plan entry may not be an absence`);
  console.log(`pool ${pool.length} shows, ${Object.keys(plan).length} with new URLs, ${Object.values(plan).reduce((a, v) => a + v.length, 0)} URLs`);
  if (arg('plan')) fs.writeFileSync(arg('plan'), JSON.stringify(plan, null, 2) + '\n');
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c || 0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
