#!/usr/bin/env node
'use strict';

/**
 * outlet-feed-reconcile.js (BRO-5358) — ADVISORY feed-vs-corpus reconcile.
 *
 * For every show that opened in the last N days, scan the outlet feeds the
 * outlet-listing-poller already knows (RSS, WordPress API, sitemap, plain-fetch
 * listing pages; never SERP or paid scrapers) and list each item that looks like a
 * review of that show but whose URL is in no review file for it. The decision lives
 * in scripts/lib/outlet-feed-reconcile.js; this file only gathers inputs and reports.
 *
 *   node scripts/outlet-feed-reconcile.js                    all shows opened in the last 7 days
 *   node scripts/outlet-feed-reconcile.js --show=ID          one show, whatever its opening date
 *   node scripts/outlet-feed-reconcile.js --show=ID --drop-url=SUBSTR [--drop-url=...]
 *       replay: pretend review files whose URL contains SUBSTR were never ingested
 *   --window-days=N  --lookback-days=N  --no-write  --json  --strict (exit 1 on a matched gap)
 *
 * Writes data/audit/outlet-feed-reconcile.json (unless --no-write). Exit 0 unless --strict.
 * Needs data/review-texts (a show whose directory is absent is reported as skipped,
 * never as a gap: reviews.json alone cannot see flagged files).
 */

const fs = require('fs');
const path = require('path');
const { reconcileFeedItems, recentlyOpenedShows, DEFAULT_WINDOW_DAYS } = require('./lib/outlet-feed-reconcile');
const poller = require('./outlet-listing-poller');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const REJECTED_PATH = path.join(ROOT, 'data', 'audit', 'outlet-poller-rejected-urls.json');
const OUT_PATH = path.join(ROOT, 'data', 'audit', 'outlet-feed-reconcile.json');

function parseArgs(argv) {
  const o = { show: null, drop: [], windowDays: DEFAULT_WINDOW_DAYS, lookbackDays: 14, write: true, json: false, strict: false, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--show=')) o.show = a.slice(7);
    else if (a.startsWith('--drop-url=')) o.drop.push(a.slice(11));
    else if (a.startsWith('--window-days=')) o.windowDays = Number(a.slice(14));
    else if (a.startsWith('--lookback-days=')) o.lookbackDays = Number(a.slice(16));
    else if (a === '--no-write') o.write = false;
    else if (a === '--json') o.json = true;
    else if (a === '--strict') o.strict = true;
  }
  return o;
}

/** URLs held for a show: every review file (flagged or not), reviews.json, and durable poller rejections. */
function loadKnownUrls(showId, reviewsByShow, rejected, dropSubstrings) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return null;
  const urls = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d && d.url) urls.add(d.url);
      if (d && Array.isArray(d.altUrls)) d.altUrls.forEach((u) => urls.add(u));
    } catch { /* an unreadable file cannot vouch for a URL */ }
  }
  for (const r of reviewsByShow.get(showId) || []) if (r.url) urls.add(r.url);
  for (const e of rejected) if (e && e.showId === showId && e.url) urls.add(e.url);
  return [...urls].filter((u) => !dropSubstrings.some((sub) => u.includes(sub)));
}

async function gatherFeedItems(lookbackDays) {
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  const jobs = [];
  for (const [outletId, sc] of Object.entries(poller.OUTLET_STRATEGY_CONFIG)) {
    if (poller.SKIP_OUTLETS.has(outletId)) continue;
    // proxyRetry off (rss + sitemap): this step is plain HTTP by design (no scraper secrets, 5-min budget).
    if (sc.strategy === 'rss') jobs.push([outletId, () => poller.fetchViaRss(outletId, sc, cutoff, { proxyRetry: false })]);
    else if (sc.strategy === 'sitemap') jobs.push([outletId, () => poller.fetchViaSitemap(outletId, sc, cutoff, { proxyRetry: false })]);
    else if (sc.strategy === 'listing-html' && sc.usePlainFetch) jobs.push([outletId, () => poller.fetchViaListingHtml(outletId, sc.url, sc.urlFilter, true)]);
  }
  for (const [outletId, cfg] of Object.entries(poller.WP_API_CONFIG)) {
    if (!poller.SKIP_OUTLETS.has(outletId)) jobs.push([outletId, () => poller.fetchViaWpApi(outletId, cfg, cutoff)]);
  }
  const items = [];
  const failed = [];
  const log = console.log;
  console.log = () => {}; // the poller's fetchers narrate every feed; the report below is the output
  try {
    for (const [outletId, run] of jobs) {
      try { for (const it of await run()) items.push({ ...it, outletId }); } catch (e) { failed.push({ outletId, error: String(e.message || e).slice(0, 120) }); }
    }
  } finally { console.log = log; }
  return { items, failed, feedsChecked: jobs.length };
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*\n/, '')); return 0; }
  const nowMs = Date.now();
  const { shows } = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const activeShows = shows.filter((s) => s.status === 'open' || s.status === 'previews');
  const targets = o.show ? shows.filter((s) => s.id === o.show) : recentlyOpenedShows(activeShows, nowMs, o.windowDays);
  if (o.show && targets.length === 0) { console.error(`unknown show id: ${o.show}`); return 2; }

  const reviewsByShow = new Map();
  try {
    for (const r of JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8')).reviews) {
      if (!reviewsByShow.has(r.showId)) reviewsByShow.set(r.showId, []);
      reviewsByShow.get(r.showId).push(r);
    }
  } catch { /* review files remain the primary source */ }
  let rejected = [];
  try { rejected = JSON.parse(fs.readFileSync(REJECTED_PATH, 'utf8')); } catch { /* no cache yet */ }

  const knownUrls = {};
  const skipped = [];
  const reconcilable = [];
  for (const show of targets) {
    const urls = loadKnownUrls(show.id, reviewsByShow, Array.isArray(rejected) ? rejected : [], o.drop);
    if (urls === null) { skipped.push({ showId: show.id, reason: 'no data/review-texts directory for this show' }); continue; }
    knownUrls[show.id] = urls;
    reconcilable.push(show);
  }

  const feeds = reconcilable.length ? await gatherFeedItems(o.lookbackDays) : { items: [], failed: [], feedsChecked: 0 };
  const result = reconcileFeedItems({ activeShows, targetShows: reconcilable, items: feeds.items, knownUrls, nowMs, windowDays: o.windowDays });

  const report = {
    generatedAt: new Date(nowMs).toISOString(),
    advisory: true,
    windowDays: o.windowDays,
    shows: reconcilable.map((s) => ({ id: s.id, title: s.title, openingDate: s.openingDate })),
    skipped,
    feedsChecked: feeds.feedsChecked,
    feedsFailed: feeds.failed,
    itemsScanned: feeds.items.length,
    matchedGaps: result.matchedCount,
    possibleGaps: result.possibleCount,
    gaps: result.gaps,
    replayDropped: o.drop.length ? o.drop : undefined,
  };

  if (o.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`[feed-reconcile] ${report.shows.length} show(s), ${report.itemsScanned} feed items from ${report.feedsChecked} feeds (${report.feedsFailed.length} failed)`);
    for (const s of skipped) console.log(`  skipped ${s.showId}: ${s.reason}`);
    if (o.drop.length) console.log(`  replay: URLs containing ${o.drop.map((d) => JSON.stringify(d)).join(', ')} treated as never ingested`);
    if (reconcilable.length === 0) console.log('  nothing reconciled (no target show with a review-texts directory)');
    else if (result.gaps.length === 0) console.log('  no gaps: every matching feed item is already in the corpus');
    for (const g of result.gaps) console.log(`  ${g.level.toUpperCase()} GAP ${g.showId} <- ${g.outletId} ${g.publishDate || ''} ${g.url}`);
  }
  if (o.write) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  }
  return o.strict && result.matchedCount > 0 ? 1 : 0;
}

if (require.main === module) {
  main().then((c) => process.exit(c), (e) => { console.error('[feed-reconcile] fatal:', e); process.exit(0); });
}

module.exports = { parseArgs, loadKnownUrls };
