#!/usr/bin/env node
/**
 * audit-outlet-ground-truth.js — ask the outlets what they reviewed, and
 * recover (or alert on) every review we don't have (BRO-4431).
 *
 * Sources (lib/outlet-ground-truth.js has the matching logic):
 *   - WordPress search APIs: TheaterMania, WhatsOnStage (`news` post type),
 *     New York Stage Review, New York Theater — one search per recent show.
 *   - NYT daily sitemap pages (theater review URLs of the last few days).
 *   - theatre.reviews round-ups for London shows: every critic listed,
 *     including paywalled Times/FT/i entries with no public link.
 *
 * For each listed review we don't hold:
 *   --ingest  URL rows run ingest-review-from-url.js --stub-on-failure (the
 *             fan-out, paywall rating salvage and retry stub all apply);
 *             theatre.reviews rows are written through the TR writer, which
 *             relays the star rating onto paywalled stubs.
 *   --alert   anything still missing after that is routed to the owner
 *             digest (owner-alert-router, 7-day per-review cooldown).
 *
 * Run by audit-aggregator-gap.yml (hourly), throttled here to once per
 * --min-interval-hours (default 6), so a missing review alerts within a day.
 *
 * Usage:
 *   node scripts/audit-outlet-ground-truth.js [--days=21] [--show=ID]
 *     [--sources=theatermania,nytimes,...] [--ingest] [--ingest-cap=12]
 *     [--alert] [--min-interval-hours=6] [--dry-run]
 *
 * Output: data/audit/outlet-ground-truth.json
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { runMain } = require('./lib/run-main');

const USAGE = `audit-outlet-ground-truth.js — compare outlets' own review listings with our review files.

Usage:
  node scripts/audit-outlet-ground-truth.js [--days=21] [--show=ID] [--sources=a,b]
    [--ingest] [--ingest-cap=12] [--alert] [--min-interval-hours=6] [--dry-run]
  node scripts/audit-outlet-ground-truth.js --help, -h    print this usage and exit
`;

const ROOT = process.env.BSC_DATA_ROOT || path.join(__dirname, '..');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
const REPORT_PATH = path.join(ROOT, 'data', 'audit', 'outlet-ground-truth.json');

function argVal(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : dflt;
}
const has = (f) => process.argv.includes(`--${f}`);

function directGet(url, timeoutMs = 20000, redirects = 4) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', Accept: '*/*' },
      timeout: timeoutMs,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(directGet(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// Plain request first (these listings are public and cheap); fall back to the
// shared scraper chain only when a runner is blocked.
async function fetchText(url) {
  try {
    return await directGet(url);
  } catch (e) {
    const { fetchPage } = require('./lib/scraper');
    const r = await fetchPage(url, { timeout: 30000 });
    return r && typeof r === 'object' ? r.content : r;
  }
}

async function fetchJsonList(url) {
  const { fetchJSON } = require('./lib/scraper');
  const j = await fetchJSON(url);
  return Array.isArray(j) ? j : [];
}

function loadShowFiles(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('_')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* skip */ }
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const {
    WP_SEARCH_SOURCES, marketOf, eligibleShows, wpSearchUrl, reviewPostsForShow,
    parseNytSitemapDay, nytShowsForSlug, hasReviewFor,
  } = require('./lib/outlet-ground-truth');

  const days = Number(argVal('days', '21'));
  const onlyShow = argVal('show', null);
  const sourceFilter = argVal('sources', null);
  const wantSource = (id) => !sourceFilter || sourceFilter.split(',').includes(id);
  const ingest = has('ingest') && !has('dry-run');
  const ingestCap = Number(argVal('ingest-cap', '12'));
  const alert = has('alert') && !has('dry-run');
  const minIntervalH = Number(argVal('min-interval-hours', '0'));
  // Ingests stop once this much wall time has passed, so the calling job keeps
  // its headroom for the commit/push steps that follow.
  const budgetMs = Number(argVal('time-budget-min', '9')) * 60000;
  const startedAt = Date.now();

  if (minIntervalH > 0 && !onlyShow && fs.existsSync(REPORT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
      const ageH = (Date.now() - Date.parse(prev.generatedAt)) / 3600e3;
      if (ageH < minIntervalH) {
        console.log(`Last ground-truth audit ${ageH.toFixed(1)}h ago (< ${minIntervalH}h) — skipping.`);
        return;
      }
    } catch { /* unreadable report: run */ }
  }

  const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  const allShows = showsRaw.shows || showsRaw;
  const shows = eligibleShows(allShows, { days, onlyShow });
  const byMarket = { nyc: shows.filter((s) => marketOf(s.category) === 'nyc'), london: shows.filter((s) => marketOf(s.category) === 'london') };
  console.log(`Ground-truth audit: ${shows.length} shows (${byMarket.nyc.length} NYC, ${byMarket.london.length} London), last ${days}d`);

  const listed = []; // { source, showId, outletId, url, critic, stars, date, trRow? }
  const sourceStats = {};
  const note = (id, k) => { sourceStats[id] = sourceStats[id] || { queries: 0, listed: 0, errors: 0 }; sourceStats[id][k]++; };
  // Listing gets half the time budget; the rest is for ingest.
  const listingOver = () => Date.now() - startedAt > budgetMs / 2;
  let listingTruncated = false;

  // 1. WordPress search APIs, one query per show.
  for (const src of WP_SEARCH_SOURCES) {
    if (!wantSource(src.id)) continue;
    for (const show of byMarket[src.market] || []) {
      if (listingOver()) { listingTruncated = true; break; }
      const after = new Date(Date.parse(show.openingDate) - 21 * 86400000).toISOString();
      note(src.id, 'queries');
      try {
        const posts = await fetchJsonList(wpSearchUrl(src.api, show.title, after));
        for (const p of reviewPostsForShow(posts, show, src)) {
          note(src.id, 'listed');
          listed.push({ source: src.id, showId: show.id, outletId: src.outletId, url: p.url, date: p.date });
        }
      } catch (e) {
        note(src.id, 'errors');
        console.log(`  [${src.id}] ${show.id}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // 2. NYT daily sitemaps (last 4 days).
  if (wantSource('nytimes') && byMarket.nyc.length) {
    for (let i = 0; i < 4; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const ymd = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
      note('nytimes', 'queries');
      try {
        const html = await fetchText(`https://www.nytimes.com/sitemap/${ymd}/`);
        for (const row of parseNytSitemapDay(html)) {
          for (const show of nytShowsForSlug(row.slug, byMarket.nyc)) {
            note('nytimes', 'listed');
            listed.push({ source: 'nytimes', showId: show.id, outletId: 'nytimes', url: row.url, date: row.date });
          }
        }
      } catch (e) {
        note('nytimes', 'errors');
        console.log(`  [nytimes] ${ymd}: ${e.message}`);
      }
    }
  }

  // 3. theatre.reviews round-ups for London shows.
  if (wantSource('theatre-reviews') && byMarket.london.length) {
    const { pickTheatreReviewsRoundup } = require('./lib/theatre-reviews-discovery');
    const { extractReviews } = require('./scrape-theatre-reviews');
    const { resolveArchiveRowOutletId } = require('./lib/archive-outlet-identity');
    const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
    const tracked = registry.outlets || registry;
    for (const show of byMarket.london) {
      if (listingOver()) { listingTruncated = true; break; }
      note('theatre-reviews', 'queries');
      try {
        const after = new Date(Date.parse(show.openingDate) - 7 * 86400000).toISOString();
        const posts = await fetchJsonList(`https://theatre.reviews/wp-json/wp/v2/posts?per_page=5&after=${encodeURIComponent(after)}&search=${encodeURIComponent(show.title)}`);
        const roundup = pickTheatreReviewsRoundup(posts, show.title);
        if (!roundup) continue;
        const html = await fetchText(roundup);
        for (const r of extractReviews(html, show.id)) {
          const outletId = resolveArchiveRowOutletId({ url: r.url, outletLabel: r.outlet, cachedOutletId: r.outletId });
          if (!outletId || !tracked[outletId]) continue;
          note('theatre-reviews', 'listed');
          listed.push({ source: 'theatre-reviews', showId: show.id, outletId, url: r.url || null, critic: r.critic, stars: r.stars, trRow: r });
        }
      } catch (e) {
        note('theatre-reviews', 'errors');
        console.log(`  [theatre-reviews] ${show.id}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // Gaps: listed but not held.
  const filesCache = new Map();
  const files = (id) => { if (!filesCache.has(id)) filesCache.set(id, loadShowFiles(id)); return filesCache.get(id); };
  const seen = new Set();
  let gaps = [];
  for (const row of listed) {
    const key = `${row.showId}|${row.url || `${row.outletId}:${row.critic}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!hasReviewFor(files(row.showId), row)) gaps.push(row);
  }
  console.log(`\nListed ${listed.length} reviews, ${gaps.length} missing:`);
  for (const g of gaps) console.log(`  - ${g.showId} ${g.outletId} ${g.url || `(no link) ${g.critic} ${g.stars || '-'}★`} [${g.source}]`);

  const ingested = [];
  const writeReport = (phase) => {
    if (has('dry-run')) return;
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(),
      phase,
      days,
      shows: shows.length,
      sources: sourceStats,
      listingTruncated,
      listed: listed.length,
      ingested,
      missing: gaps.map(({ trRow, ...g }) => g),
    }, null, 2) + '\n');
  };
  // Written before ingest too, so the --min-interval-hours throttle holds even
  // when the calling step's `timeout` kills a slow ingest.
  writeReport('listed');

  // Recover.
  if (ingest && gaps.length) {
    let n = 0;
    const trByShow = new Map();
    for (const g of gaps) {
      if (g.source === 'theatre-reviews') {
        if (!trByShow.has(g.showId)) trByShow.set(g.showId, []);
        trByShow.get(g.showId).push(g.trRow);
        continue;
      }
      if (n >= ingestCap || Date.now() - startedAt > budgetMs) continue;
      n++;
      try {
        execFileSync('node', [path.join(__dirname, 'ingest-review-from-url.js'), `--show=${g.showId}`, `--url=${g.url}`, '--stub-on-failure'],
          { stdio: 'inherit', timeout: 240000 });
        ingested.push({ showId: g.showId, url: g.url, ok: true });
      } catch (e) {
        ingested.push({ showId: g.showId, url: g.url, ok: false, error: String(e.message).split('\n')[0] });
      }
    }
    if (trByShow.size) {
      const { writeReviewFiles } = require('./scrape-theatre-reviews');
      for (const [showId, rows] of trByShow) {
        const r = writeReviewFiles(rows, showId, REVIEW_TEXTS_DIR);
        ingested.push({ showId, source: 'theatre-reviews', ok: true, created: r.created, updated: r.updated });
      }
    }
    filesCache.clear();
    gaps = gaps.filter((g) => !hasReviewFor(files(g.showId), g));
    console.log(`After ingest: ${gaps.length} still missing.`);
  }

  // Alert on what's still missing.
  if (alert && gaps.length) {
    const { routeAlert } = require('./lib/owner-alert-router');
    for (const g of gaps) {
      try {
        await routeAlert({
          conditionKey: `outlet-ground-truth:${g.showId}:${g.url || `${g.outletId}:${g.critic}`}`,
          title: `Missing review from a tracked outlet: ${g.showId} — ${g.outletId}`,
          description: `${g.source} lists a review we don't hold${g.url ? ` (${g.url})` : ` (no public link; critic ${g.critic || 'unknown'}${g.stars ? `, ${g.stars} stars` : ''})`}, and automatic ingest did not recover it.`,
          hint: g.url ? `node scripts/ingest-review-from-url.js --show=${g.showId} --url=${g.url}` : `node scripts/scrape-theatre-reviews.js --shows=${g.showId} --force`,
          severity: 'warning',
          disposition: 'digest',
        });
      } catch (e) {
        console.log(`  alert failed for ${g.showId}: ${e.message}`);
      }
    }
  }

  writeReport('done');
}

// BRO-4623: fetchText() falls back to fetchPage(), whose Playwright tier
// leaves Chromium open; `main().catch(... process.exit(1))` only exited on
// failure, so a successful run could sit until the workflow's `timeout 720`
// killed it (audit-fetchpage-cleanup.js: UNSAFE_CATCH_ONLY). runMain awaits
// the scraper's cleanup() and then exits explicitly. The scraper is
// lazy-required, so clean it up only when this run actually loaded it.
function cleanupScraperIfLoaded() {
  const scraperPath = require.resolve('./lib/scraper');
  return require.cache[scraperPath] ? require(scraperPath).cleanup() : undefined;
}

runMain(main, { teardown: [cleanupScraperIfLoaded] });
