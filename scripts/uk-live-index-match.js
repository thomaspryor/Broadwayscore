#!/usr/bin/env node
'use strict';
/**
 * BRO-6692: find WhatsOnStage, British Theatre Guide and Reviews Hub reviews for UK hub shows
 * that are still under the scoreable bar, from each outlet's own index.
 *
 *   node scripts/uk-live-index-match.js [--ids=a,b] [--all] [--plan=<out.json>] [--verbose]
 *
 * Default pool: uk-regional-coverage's below-bar shows. Items go through the census matcher
 * (title, house, run window; ambiguous items are dropped) and URLs already held are skipped.
 * The plan is { "<showId>": [{ "url", "outlet" }] } for scripts/dispatch-ingest-batch.js.
 * Logic: scripts/lib/uk-live-index.js. Read-only; ingest does the final page check.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { wosItems, hubItems, btgItems } = require('./lib/uk-live-index');
const { matchCensusItems } = require('./lib/uk-regional-census-match');
const { urlKey } = require('./lib/outlet-feed-reconcile');
const { heldUrlIndex } = require('./uk-regional-census-match');
const { coverage } = require('./uk-regional-coverage');
const { isUkRegionalVenue } = require('./lib/market-label');
const { isLocalOnlyShow } = require('./lib/local-market');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');

const DATA = path.join(__dirname, '..', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; BroadwayScorecardBot/1.0)' }, signal: AbortSignal.timeout(25000) });
      if (res.ok) return await res.text();
      if (res.status === 400 || res.status === 404) return '[]'; // WP answers 400 for an out-of-range page, 404 for no match
    } catch { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  return '[]';
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/uk-live-index-match.js [--ids=a,b] [--all] [--plan=<out.json>] [--verbose]');
    return 0;
  }
  const arg = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=');
  const raw = require(path.join(DATA, 'shows.json'));
  const hub = (Array.isArray(raw) ? raw : raw.shows).filter((s) => s.category === 'regional' && isUkRegionalVenue(s.venue) && !isLocalOnlyShow(s));
  const reg = require(path.join(DATA, 'outlet-registry.json'));
  const below = new Set(coverage(hub, loadReviewsWithBlog(), reg.outlets || reg).belowBar.map((b) => b.id));
  const ids = arg('ids') ? new Set(arg('ids').split(',')) : null;
  const pool = hub.filter((s) => (ids ? ids.has(s.id) : argv.includes('--all') || below.has(s.id)));
  const held = heldUrlIndex(hub.map((s) => s.id));
  const plan = {};
  const log = [];
  for (const s of pool) {
    const items = [];
    for (const read of [wosItems, hubItems, btgItems]) { items.push(...(await read(s, get))); await sleep(300); }
    const m = matchCensusItems(items, [s], held, urlKey);
    const fresh = m.matched.filter((x) => x.showId === s.id);
    const hasOutlet = (o) => (held.get(s.id) || new Set()).has(`outlet:${o}`);
    const picks = fresh.filter((x) => !hasOutlet(x.outletId));
    log.push({ id: s.id, candidates: items.length, matched: fresh.length, new: picks.length });
    if (picks.length) plan[s.id] = picks.map((x) => ({ url: x.url, outlet: x.outletId }));
    if (argv.includes('--verbose')) console.log(`${s.id}: ${items.length} candidates, ${fresh.length} matched, ${picks.length} new${picks.length ? ' -> ' + picks.map((x) => `${x.outletId}:${x.url.split('/').filter(Boolean).pop()}`).join(' | ') : ''}`);
  }
  console.log(`pool ${pool.length} shows, ${Object.keys(plan).length} with a new review, ${Object.values(plan).reduce((a, v) => a + v.length, 0)} URLs`);
  if (arg('plan')) fs.writeFileSync(arg('plan'), JSON.stringify(plan, null, 2) + '\n');
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c || 0)).catch((e) => { console.error(e); process.exit(1); });
module.exports = { main };
