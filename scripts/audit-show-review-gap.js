#!/usr/bin/env node
/**
 * audit-show-review-gap.js
 *
 * Show-centric review gap audit. For each open show in the opening-night
 * window, find its Playbill Verdict + BWW Review Roundup aggregator
 * articles, extract the outlet review URLs those articles list, and diff
 * against what we have in data/review-texts/{showId}/ + reviews.json.
 *
 * Why this exists:
 *   The opening-night poller/gather already finds reviews via SERP +
 *   outlet RSS + dedicated aggregator scrapers, but its discovery is
 *   per-outlet and per-URL-pattern. Aggregator articles are the canonical
 *   "here are the reviews for THIS show" lists curated by Playbill/BWW
 *   editors — using them as a gap reference catches the long tail of
 *   reviews from blogs/niche outlets that aren't in our outlet-registry.
 *
 *   Surfaced concrete gaps 2026-05-27 (Notion 36d637c5-416f-81d4):
 *     - Animal Wisdom: 9 reviews on Playbill Verdict, 3 in reviews.json
 *     - The Maids: 6 listed, 5 ours (NYT URL discovered but mis-routed)
 *     - Heated Rivalry: 4 listed, 3 ours
 *
 * Modes:
 *   --show=ID             one show only
 *   --window=14           every open show opened within N days (default 21)
 *   --fail-on-gap         exit 1 when any in-window show has missing URLs
 *   --dispatch-gather     gh workflow run gather-reviews.yml for each show
 *                         that has a gap > 0 (rate-limited at 1 dispatch/show)
 *   --ingest-missing      run scripts/ingest-review-from-url.js directly for
 *                         each missing aggregator URL whose outlet is in the
 *                         registry. Targets the specific URL rather than re-
 *                         running gather's SERP+RSS discovery (which already
 *                         failed). Cap of 5 URLs/show via --ingest-cap=N.
 *   --ingest-cap=N        per-show ingest cap (default 5)
 *   --dry-run             don't write audit file
 *   --verbose             log per-show details to stdout
 *
 * Output: data/audit/show-review-gap.json
 *
 * Usage:
 *   node scripts/audit-show-review-gap.js --show=the-maids-off-broadway-2026
 *   node scripts/audit-show-review-gap.js --window=21 --dispatch-gather
 *   node scripts/audit-show-review-gap.js --window=21 --fail-on-gap   # CI
 */

'use strict';

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { execSync, execFileSync } = require('child_process');

const { fetchPage } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');
const { provisionalOutletIdFromHost } = require('./lib/outlet-canonicalize');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_PATH = path.join(ROOT, 'data', 'reviews.json');
const OUTLET_REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');
// REVIEW_TEXTS_DIR can be overridden via env so local runs can point at the
// user's master ~/broadway-review-texts checkout (which is fresher than a
// worktree's stale copy). CI's checkout-core-data action populates
// data/review-texts directly so the default works there.
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR
  || path.join(ROOT, 'data', 'review-texts');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'show-review-gap.json');
const UNKNOWN_OUTLETS_PATH = path.join(ROOT, 'data', 'audit', 'unknown-aggregator-outlets.json');

const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const windowDays = parseInt(args.find(a => a.startsWith('--window='))?.split('=')[1] || '21', 10);
const failOnGap = args.includes('--fail-on-gap');
const dispatchGather = args.includes('--dispatch-gather');
const ingestMissing = args.includes('--ingest-missing');
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
// Cap how many URLs we ingest per show to avoid runaway loops on a noisy
// aggregator article. Each missing URL hits fetchPage which costs Bright Data
// credits — 5 per show per cron run is a sane budget.
const INGEST_PER_SHOW_CAP = parseInt(args.find(a => a.startsWith('--ingest-cap='))?.split('=')[1] || '5', 10);

// Non-review domains we ignore inside aggregator articles (platform widgets,
// social, navigation, store links, internal Playbill/BWW article navigation).
const NON_REVIEW_HOST_PATTERNS = [
  /^facebook\.com$/, /^instagram\.com$/, /^twitter\.com$/, /^x\.com$/,
  /^youtube\.com$/, /^tiktok\.com$/, /^threads\.net$/, /^linkedin\.com$/,
  /^pinterest\./, /^reddit\.com$/, /^t\.me$/, /^whatsapp\./,
  /^playbillder\.com$/, /^playbillstore\.com$/, /^playbilltravel\.com$/,
  /^stagemag\.broadwayworld\.com$/, /^broadwayworldshop\.com$/,
  /^forum\.broadwayworld\.com$/, /^data\.broadwayworld\.com$/,
  /^wisdomdigital\.com$/, /^cur8\.com$/, /^jt-pr-dot-yamm-track\.appspot\.com$/,
  // venue & box-office (not reviews)
  /\.org$/, // catches many venue domains; allow-list known critic .orgs below
  /^ci\.ovationtix\.com$/,
  // ticketing / box-office hosts — aggregator "Get Tickets" links, never reviews.
  // Before 2026-06-05 these were skipped only because their unknown outlet was
  // skipped; with auto-onboard they would be ingested as bogus "telecharge" /
  // "todaytix" provisional outlets, so they must be filtered at the source.
  /^telecharge\.com$/, /^ticketmaster\.com$/, /(^|\.)todaytix\.com$/,
  /^seatgeek\.com$/, /^stubhub\.com$/, /^broadwaydirect\.com$/,
  /(^|\.)ticketmaster\./, /^ovationtix\.com$/, /^web\.ovationtix\.com$/,
  /^tickets\./, /^boxoffice\./,
];

const ALLOWED_ORG_HOSTS = new Set([
  'artsfuse.org', 'npr.org', 'exeuntnyc.org', // edge cases that ARE review outlets
]);

const NON_REVIEW_PATH_PATTERNS = [
  /^\/article(\/|$)/, // playbill article nav
  /^\/reviews\/?$/,   // BWW landing
  /^\/industry-/, /^\/theatre-auditions/, /^\/youth-theater/,
  /^\/newsroom/, /^\/newsletter/,
  /\/tickets?(\/|$|-)/i, // "Get Tickets" / box-office links, not reviews
];

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return null; }
}

// provisionalOutletIdFromHost lives in scripts/lib/outlet-canonicalize.js so the
// gap audit and its unit test share one implementation (CLAUDE.md §15).

function isReviewUrl(href) {
  if (!href || !href.startsWith('http')) return false;
  const h = hostOf(href);
  if (!h) return false;
  if (NON_REVIEW_HOST_PATTERNS.some(rx => rx.test(h)) && !ALLOWED_ORG_HOSTS.has(h)) return false;
  // Skip Playbill/BWW internal navigation (we WANT outlet URLs, not aggregator URLs)
  if ((h === 'playbill.com' || h === 'broadwayworld.com') && !/\/(review|reviews|theater|theatre|news|stage|culture|arts)/i.test(href)) return false;
  try {
    const p = new URL(href).pathname;
    if (NON_REVIEW_PATH_PATTERNS.some(rx => rx.test(p))) return false;
  } catch { return false; }
  return true;
}

function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.shows || []);
}

// Domain → outletId map from outlet-registry.json. Used to detect aggregator-
// listed URLs whose outlet isn't in our registry (the gay-city-news /
// theknockturnal class — gather rejects them with "Could not resolve outlet"
// and the review never lands). Surfacing these in data/audit/unknown-
// aggregator-outlets.json closes the loop between gap detection and outlet
// onboarding.
let _knownDomainMap = null;
function getKnownDomainMap() {
  if (_knownDomainMap) return _knownDomainMap;
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
    const outlets = raw.outlets || raw;
    for (const [id, o] of Object.entries(outlets || {})) {
      if (!o || typeof o !== 'object') continue;
      const domains = [];
      if (typeof o.domain === 'string') domains.push(o.domain);
      if (Array.isArray(o.domains)) domains.push(...o.domains);
      if (Array.isArray(o.alternateDomains)) domains.push(...o.alternateDomains);
      for (const d of domains) {
        if (typeof d === 'string' && d) map.set(d.replace(/^www\./, '').toLowerCase(), id);
      }
    }
  } catch (e) {
    if (verbose) console.error(`  outlet-registry load failed: ${e.message}`);
  }
  _knownDomainMap = map;
  return map;
}

// Curated show → Show Score page URL map (data/show-score-urls.json), loaded once.
// Used by the Show Score reconciliation source; missing entries fall back to
// slug construction in showScoreUrlForShow.
let _showScoreUrlMap = null;
function getShowScoreUrlMap() {
  if (_showScoreUrlMap) return _showScoreUrlMap;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'show-score-urls.json'), 'utf8'));
    _showScoreUrlMap = raw.shows || raw || {};
  } catch {
    _showScoreUrlMap = {};
  }
  return _showScoreUrlMap;
}

function loadReviews() {
  const data = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  return Array.isArray(data) ? data : (data.reviews || []);
}

function loadDirFiles(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
    try { return Object.assign({ _file: f }, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }
    catch { return null; }
  }).filter(Boolean);
}

async function findAggregatorArticles(show) {
  const title = show.title;
  const id = show.id;
  const tokens = titleTokens(title);
  const queries = [
    `site:playbill.com/article "${title}" reviews`,
    `site:broadwayworld.com "Review Roundup" "${title}"`,
  ];
  const urls = new Set();
  for (const q of queries) {
    _serpStats.attempts++;
    try {
      const results = await serpQuery(q, { num: 5 });
      for (const r of (results || [])) {
        const u = r.link || r.url;
        if (!u) continue;
        // The SERP routinely returns OTHER shows' verdict/roundup articles for a
        // show's query (cold-start ranking). Require the show's title tokens in the
        // article slug so we don't fetch + extract a wrong-show roundup (e.g. the
        // "weather-girl" Playbill verdict for a "Girl, Interrupted" query —
        // girl-interrupted 2026-06-06). Verdict slugs embed the title, so a real
        // match passes; "weather-girl" matches only "girl" and is rejected.
        const clean = u.split('?')[0].split('#')[0];
        if (!urlMatchesShow(clean, tokens)) continue;
        // Playbill Verdict article patterns
        if (/playbill\.com\/article\/(read|what|reviews|critics)/i.test(u) && /\.html?$|article\//.test(u)) {
          urls.add(clean);
        }
        // BWW Review Roundup article patterns
        if (/broadwayworld\.com\/article\/Review-Roundup-/i.test(u)) {
          urls.add(clean);
        }
      }
    } catch (e) {
      _serpStats.errors++;
      if (verbose) console.error(`  SERP error for ${id}: ${e.message}`);
    }
  }
  // Deterministic BWW Review Roundup discovery via the market section page
  // (/off-broadway/ etc.) — does NOT depend on Google SERP, which ranks fresh
  // opening-night roundups poorly and missed the BWW RR for A Woman Among Women
  // (2026-06). Cheap ScrapingBee scan; falls back internally to reviews.php.
  try {
    const { discoverBwwRoundupUrl } = require('./lib/bww-rr-discover');
    const bww = await discoverBwwRoundupUrl(show);
    if (bww && bww.url) urls.add(bww.url.split('?')[0].split('#')[0]);
  } catch (e) {
    if (verbose) console.error(`  BWW section discovery error for ${id}: ${e.message}`);
  }
  return [...urls];
}

function titleTokens(title) {
  // Significant tokens (3+ chars, not stopwords) from the show title.
  // Used to filter aggregator-article links to URLs actually about THIS show
  // (vs sidebar/related-article links).
  const STOPWORDS = new Set([
    'the','and','for','off','broadway','musical','play','theater','theatre',
    'review','reviews','what','are','is','of','to','in','on','at','a','an',
    'with','by','from','presents','starring','new','york','nyc','show',
  ]);
  return (title || '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function urlMatchesShow(href, tokens) {
  if (tokens.length === 0) return true; // no tokens → accept everything
  try {
    const p = new URL(href).pathname.toLowerCase();
    // Token must match a full path SEGMENT (split on / - _ . space), not a
    // substring. P1 fix 2026-05-27 (ship-check): substring matching let
    // `maids` slip into `/the-handmaids-tale-revival` because "maids"
    // appears inside "handmaids". Segment match catches the actual show
    // slug while rejecting accidental substring overlap.
    const segments = new Set(p.split(/[\/\-_.\s]+/).filter(Boolean));
    const matched = tokens.filter(t => segments.has(t)).length;
    // Require enough DISTINCTIVE overlap so a different show that merely shares a
    // common word isn't accepted — "Weather Girl" matched "Girl, Interrupted" on
    // "girl" alone (girl-interrupted 2026-06-06), the same title-token class as the
    // original wrong-show leak. Short titles (1-2 tokens) must match ALL tokens;
    // longer titles tolerate one missing token (slug truncation / subtitle drop).
    if (tokens.length <= 2) return matched === tokens.length;
    return matched >= tokens.length - 1;
  } catch { return false; }
}

// Within-run cache of fetched aggregator articles. Playbill Verdict often
// covers multiple shows in one article (e.g. a "Best of Off-Broadway" recap
// linked from 3-5 different shows' Verdict permalinks). Without this cache,
// the hourly cron fetches the same URL N times. P1 fix 2026-05-27
// (ship-check): cap BD credit burn at ~1 fetch per unique article per run.
const _articleCache = new Map();

// Run-level fetch health. A single un-scrapeable article is tolerated (logged
// + skipped) so the hourly audit doesn't crash on one bad URL — e.g. a BWW
// `/westend/` redirect that all providers fail. But if EVERY attempted article
// fetch throws, the scraper stack itself is down (dead Bright Data zone /
// exhausted ScrapingBee / no Playwright) — the run must still redden CI so the
// outage is visible. See plan-review 2026-05-31. `errors` counts hard throws
// (all providers failed); `empty` counts 200-but-no-content (can be a legit
// page with no matching links, so it does NOT count toward the outage floor).
const _fetchStats = { attempts: 0, errors: 0, empty: 0 };

// Discovery (SERP) health — companion to _fetchStats for the OTHER outage class.
// findAggregatorArticles swallows SERP errors (returns [] on failure,
// indistinguishable from "no coverage"). Without this counter, a total SERP/key
// outage makes every show report 0 articles → extractAggregatorReviewUrls is
// never called → _fetchStats.attempts stays 0 → the article-fetch floor can't
// fire, and the audit silently reports "no gaps" during a real blackout
// (ship-check 2026-06-01, both reviewers). Count SERP calls + errors so the
// floor below catches discovery outage too.
const _serpStats = { attempts: 0, errors: 0 };

async function extractAggregatorReviewUrls(articleUrl, show) {
  let html;
  if (_articleCache.has(articleUrl)) {
    html = _articleCache.get(articleUrl);
  } else {
    _fetchStats.attempts++;
    let r;
    try {
      r = await fetchPage(articleUrl);
    } catch (e) {
      // Per-URL scrape failure. Mirror audit-url-validation.js:392 — record the
      // throw, warn, continue. The run-level floor below still reddens CI if
      // the WHOLE collector is down (every attempted fetch threw).
      _fetchStats.errors++;
      console.log(`::warning::aggregator fetch failed (${hostOf(articleUrl) || articleUrl}): ${e.message.split('\n')[0].slice(0, 120)}`);
      // Do NOT cache null on a THROW: a transient failure shouldn't poison the
      // URL for other shows that share this article, and re-attempting on each
      // show keeps _fetchStats accurate so the outage floor fires on a real
      // blackout (ship-check 2026-06-01). Only legit empty-content is cached.
      return null;
    }
    if (!r?.content) {
      _fetchStats.empty++;
      _articleCache.set(articleUrl, null);
      return null;
    }
    html = r.content;
    _articleCache.set(articleUrl, html);
  }
  if (html == null) return null;
  const $ = cheerio.load(html);
  const tokens = titleTokens(show.title);
  const urls = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!isReviewUrl(href)) return;
    if (!urlMatchesShow(href, tokens)) return;
    urls.add(href.split('?')[0].split('#')[0]);
  });
  return [...urls];
}

function classifyShowFile(d) {
  if (d.wrongProduction) return 'wrongProduction';
  if (d.wrongShow) return 'wrongShow';
  if (d.isNonReview) return 'nonReview';
  if (d.duplicateOf) return 'duplicate';
  if (d.isRoundupArticle) return 'roundup';
  return 'clean';
}

function isShowEligible(show) {
  if (!show.openingDate) return false;
  if (!['open', 'previews'].includes(show.status)) return false;
  const opened = new Date(show.openingDate);
  const today = new Date();
  const diffDays = (today - opened) / 86400000;
  // Eligible if opened within window OR in pre-opening (<=3 days from now)
  return diffDays >= -3 && diffDays <= windowDays;
}

async function auditShow(show) {
  const result = {
    showId: show.id,
    title: show.title,
    openingDate: show.openingDate,
    status: show.status,
    category: show.category,
    aggregatorArticles: [],
    aggregatorListedUrls: [],
    dirFiles: 0,
    dirClean: 0,
    inReviewsJson: 0,
    missing: [],         // urls listed by aggregator but not in dir
    dirOnly: [],         // urls in dir but not on aggregator (FYI, not necessarily bad)
    flaggedMisses: [],   // urls listed by aggregator that ARE in dir but flagged out
  };

  const articles = await findAggregatorArticles(show);
  result.aggregatorArticles = articles;

  const aggUrls = new Set();
  for (const art of articles) {
    const urls = await extractAggregatorReviewUrls(art, show);
    if (urls) for (const u of urls) aggUrls.add(u);
  }

  // Show Score per-show page → direct outlet review URLs. Show Score covers
  // off-Broadway (unlike DTLI, which is Broadway-only) — it lands later and
  // lists fewer reviews than Playbill/BWW, but the hourly audit eventually
  // reconciles a review that surfaced only there. Filtered through the same
  // isReviewUrl + urlMatchesShow gates so ticketing/maps/form links on the
  // Show Score page never become bogus "missing reviews" (girl-interrupted
  // 2026-06-06 — same class as the telecharge false-positive).
  try {
    const { showScoreUrlForShow, extractShowScoreReviewUrls } = require('./lib/show-score-discover');
    const ssUrl = showScoreUrlForShow(show, getShowScoreUrlMap());
    if (ssUrl) {
      const r = await fetchPage(ssUrl, { timeout: 45000 });
      const html = (typeof r === 'string') ? r : ((r && (r.content || r.html || r.body)) || '');
      const tokens = titleTokens(show.title);
      for (const u of extractShowScoreReviewUrls(html)) {
        if (isReviewUrl(u) && urlMatchesShow(u, tokens)) {
          aggUrls.add(u.split('?')[0].split('#')[0]);
        }
      }
    }
  } catch (e) {
    if (verbose) console.error(`  Show Score discovery error for ${show.id}: ${e.message}`);
  }

  result.aggregatorListedUrls = [...aggUrls];
  if (aggUrls.size === 0) return result;

  const dirData = loadDirFiles(show.id);
  result.dirFiles = dirData.length;

  // Map dir files by hostname (multiple files per host possible)
  const dirByHost = new Map();
  for (const d of dirData) {
    const h = hostOf(d.url || '');
    if (!h) continue;
    if (!dirByHost.has(h)) dirByHost.set(h, []);
    dirByHost.get(h).push(d);
    if (classifyShowFile(d) === 'clean') result.dirClean++;
  }

  const reviewsJson = loadReviews();
  result.inReviewsJson = reviewsJson.filter(r => r.showId === show.id).length;

  // For each aggregator-listed URL: is it covered locally?
  const knownDomains = getKnownDomainMap();
  for (const aggUrl of aggUrls) {
    const aggHost = hostOf(aggUrl);
    if (!aggHost) continue;
    const knownOutletId = knownDomains.get(aggHost) || null;
    const dirFiles = dirByHost.get(aggHost) || [];
    if (dirFiles.length === 0) {
      result.missing.push({ url: aggUrl, host: aggHost, knownOutletId });
    } else {
      const clean = dirFiles.filter(d => classifyShowFile(d) === 'clean');
      if (clean.length === 0) {
        result.flaggedMisses.push({
          url: aggUrl,
          host: aggHost,
          dirFlags: dirFiles.map(d => ({ file: d._file, flag: classifyShowFile(d), urlInDir: d.url })),
        });
      }
    }
  }

  // dirOnly: hosts in dir clean but not on aggregator
  const aggHosts = new Set([...aggUrls].map(hostOf));
  for (const [h, files] of dirByHost) {
    if (aggHosts.has(h)) continue;
    const clean = files.filter(d => classifyShowFile(d) === 'clean');
    if (clean.length > 0) {
      result.dirOnly.push({ host: h, count: clean.length });
    }
  }

  return result;
}

// Use execFileSync (no shell) so attacker-controllable URLs from aggregator
// pages can't smuggle backticks/$()/$VAR/newlines into a shell. P0 fix
// 2026-05-27 (ship-check). The earlier execSync apostrophe-only escape was
// insufficient — aggregator pages are third-party HTML that can include
// arbitrary anchor href values.
//
// P1 fix 2026-05-27 (ship-check): skip dispatch if gather-reviews already ran
// for this show within the last 2 hours. Without this, the hourly cron would
// re-dispatch the same failing-to-find show indefinitely (gather can't find
// what gather couldn't find an hour ago). Two-hour cooldown matches the
// orchestrator's poll cadence so we don't fight it.
const GATHER_DISPATCH_COOLDOWN_MS = 2 * 60 * 60 * 1000;
function recentlyDispatched(showId) {
  try {
    const out = execFileSync('gh', [
      'run', 'list',
      '--workflow=gather-reviews.yml',
      '--limit=20',
      '--json=createdAt,displayTitle,event',
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).toString();
    const runs = JSON.parse(out);
    const now = Date.now();
    for (const run of runs) {
      const title = (run.displayTitle || '').toLowerCase();
      // gather-reviews dispatches with `shows=<id>` show up in displayTitle.
      // Fall through to any workflow_dispatch within window as a fail-safe.
      if (title.includes(showId.toLowerCase()) || run.event === 'workflow_dispatch') {
        const age = now - Date.parse(run.createdAt);
        if (age < GATHER_DISPATCH_COOLDOWN_MS && title.includes(showId.toLowerCase())) {
          return true;
        }
      }
    }
  } catch { /* fail-open: better to dispatch on uncertain history than block */ }
  return false;
}
async function dispatchGatherFor(showId) {
  if (recentlyDispatched(showId)) {
    console.log(`  ⏸  gather-reviews dispatched within last 2h for ${showId} — skipping`);
    return false;
  }
  try {
    execFileSync('gh', ['workflow', 'run', 'gather-reviews.yml', '-f', `shows=${showId}`], { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error(`  dispatch failed for ${showId}: ${e.message}`);
    return false;
  }
}

// Direct ingest of a missing URL via scripts/ingest-review-from-url.js. Unlike
// dispatchGatherFor (which re-runs SERP discovery — the same pipeline that
// already failed to find this URL), this targets the specific aggregator-
// listed URL. Closes the systemic gap where Playbill Verdict / BWW RR lists a
// review URL but our outlet-registry or SERP cadence misses it.
//
// Returns { ok, reason } so the caller can log per-URL outcomes. Skips URLs
// whose host is unknown to the registry (those should be added to the registry
// first via the unknown-aggregator-outlets audit).
function ingestMissingUrl(showId, url, knownOutletId) {
  const args = ['scripts/ingest-review-from-url.js', `--show=${showId}`, `--url=${url}`];
  let provisional = false;
  if (knownOutletId) {
    args.push(`--outlet=${knownOutletId}`);
  } else {
    // Auto-onboard: capture the review under a domain-derived provisional slug
    // rather than skipping (the pre-2026-06-05 behavior, which lost the ctvoice /
    // New York Notebook class). The host is still recorded in
    // unknown-aggregator-outlets.json so it can be promoted to a real registry
    // entry; --provisional skips fuzzy alias resolution so the slug is written as-is.
    const provId = provisionalOutletIdFromHost(hostOf(url));
    if (!provId) return { ok: false, reason: 'unknown-outlet-no-host', provisional: true };
    args.push(`--outlet=${provId}`, '--provisional');
    provisional = true;
  }
  try {
    execFileSync('node', args, { stdio: 'pipe', timeout: 120000 });
    return { ok: true, reason: null, provisional };
  } catch (e) {
    return { ok: false, reason: e.message.split('\n')[0].slice(0, 100), provisional };
  }
}

// CLI entry — guarded so the module can be require()'d by unit tests without
// running the audit (CLAUDE.md §15: test the real urlMatchesShow/titleTokens).
if (require.main === module) (async () => {
  const allShows = loadShows();
  let targets;
  if (showFilter) {
    targets = allShows.filter(s => s.id === showFilter);
    if (targets.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  } else {
    targets = allShows.filter(isShowEligible);
  }

  console.log(`audit-show-review-gap: ${targets.length} target(s) (window=${windowDays}d)`);

  const results = [];
  const dispatched = new Set();
  for (const s of targets) {
    if (verbose) console.log(`\n${s.id} "${s.title}" (${s.openingDate} ${s.status})`);
    const r = await auditShow(s);
    results.push(r);
    const gapTotal = r.missing.length + r.flaggedMisses.length;
    const summary = `  ${r.inReviewsJson}/${r.aggregatorListedUrls.length || '?'} reviews | ${gapTotal} gap (missing=${r.missing.length} flagged=${r.flaggedMisses.length})`;
    if (verbose || gapTotal > 0) console.log(`${r.showId}${verbose ? '' : ': ' + r.title}\n${summary}`);
    if (verbose && r.missing.length > 0) {
      for (const m of r.missing) console.log(`    ❌ ${m.url}`);
    }
    if (verbose && r.flaggedMisses.length > 0) {
      for (const m of r.flaggedMisses) console.log(`    ⚠️ ${m.url} (flagged: ${m.dirFlags.map(f => f.flag).join(',')})`);
    }
    if (dispatchGather && gapTotal > 0 && !dispatched.has(r.showId)) {
      const ok = await dispatchGatherFor(r.showId);
      if (ok) {
        dispatched.add(r.showId);
        console.log(`  ⤳ dispatched gather-reviews for ${r.showId}`);
      }
    }
    // --ingest-missing: directly ingest each missing aggregator URL whose host
    // is in our outlet-registry. Targets the specific URL rather than re-
    // running gather's SERP+RSS discovery (which already failed). Unknown
    // outlets are skipped (see data/audit/unknown-aggregator-outlets.json for
    // registry-onboarding queue).
    if (ingestMissing && r.missing.length > 0) {
      // Auto-onboard 2026-06-05: ingest ALL missing URLs, not just registry-known
      // outlets. Unknown outlets are captured under a domain-derived provisional
      // slug (ingestMissingUrl) instead of being skipped — that skip lost the
      // ctvoice / New York Notebook class on the Girl, Interrupted opening. The
      // host is still recorded in unknown-aggregator-outlets.json for promotion
      // to a real registry entry.
      const ingestable = r.missing.slice(0, INGEST_PER_SHOW_CAP);
      // P1 fix 2026-05-27 (ship-check): record cap-skipped URLs so future runs
      // (and operators) can see they exist and weren't silently dropped.
      const cappedSkipped = r.missing.slice(INGEST_PER_SHOW_CAP);
      r.ingestResults = [];
      r.ingestSkippedByCap = cappedSkipped.map(m => ({ url: m.url, host: m.host, outletId: m.knownOutletId || provisionalOutletIdFromHost(m.host) }));
      for (const m of ingestable) {
        const res = ingestMissingUrl(r.showId, m.url, m.knownOutletId);
        const outletId = m.knownOutletId || provisionalOutletIdFromHost(m.host);
        r.ingestResults.push({ url: m.url, host: m.host, outletId, provisional: !!res.provisional, ok: res.ok, reason: res.reason });
        const tag = res.ok ? (res.provisional ? `✅ ingested (provisional outlet "${outletId}")` : '✅ ingested') : `✗ ingest failed (${res.reason || 'unknown'})`;
        console.log(`  ${tag}: ${m.url}`);
      }
      if (cappedSkipped.length > 0) {
        console.log(`  ⏸  skipped ${cappedSkipped.length} URL(s) over per-show cap (--ingest-cap=${INGEST_PER_SHOW_CAP}) — recorded in audit JSON for next run`);
      }
    }
  }

  const audit = {
    generatedAt: new Date().toISOString(),
    windowDays,
    targets: targets.length,
    counts: {
      withGap: results.filter(r => r.missing.length + r.flaggedMisses.length > 0).length,
      totalMissing: results.reduce((a, r) => a + r.missing.length, 0),
      totalFlaggedMisses: results.reduce((a, r) => a + r.flaggedMisses.length, 0),
    },
    results,
  };

  // Roll up unknown outlet hosts: hosts that aggregator articles linked to
  // but our outlet-registry.json doesn't recognize. These are the gather
  // chain's blind spots — gather rejects them with "Could not resolve outlet
  // from URL" and the review never lands. (gaycitynews.com and theknockturnal.com
  // on 2026-05-27 — both registered after this audit surfaced them.)
  const unknownOutletHosts = new Map();
  for (const r of results) {
    for (const m of r.missing) {
      if (m.knownOutletId) continue;
      if (!unknownOutletHosts.has(m.host)) {
        unknownOutletHosts.set(m.host, { host: m.host, provisionalOutletId: provisionalOutletIdFromHost(m.host), occurrences: 0, sampleUrls: [], shows: new Set() });
      }
      const e = unknownOutletHosts.get(m.host);
      e.occurrences++;
      if (e.sampleUrls.length < 3) e.sampleUrls.push(m.url);
      e.shows.add(r.showId);
    }
  }
  const unknownOutlets = [...unknownOutletHosts.values()]
    .map(e => ({ ...e, shows: [...e.shows] }))
    .sort((a, b) => b.occurrences - a.occurrences);

  if (!dryRun) {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(AUDIT_PATH, JSON.stringify(audit, null, 2));
    console.log(`\nWrote audit: ${AUDIT_PATH}`);
    fs.writeFileSync(UNKNOWN_OUTLETS_PATH, JSON.stringify({
      generatedAt: audit.generatedAt,
      count: unknownOutlets.length,
      outlets: unknownOutlets,
    }, null, 2));
    console.log(`Wrote unknown-outlets: ${UNKNOWN_OUTLETS_PATH} (${unknownOutlets.length} hosts)`);
  }
  console.log(`Summary: ${audit.counts.withGap}/${targets.length} shows with gaps | ${audit.counts.totalMissing} URLs not in dir | ${audit.counts.totalFlaggedMisses} URLs in dir but flagged out | ${unknownOutlets.length} unknown outlets`);
  if (verbose && unknownOutlets.length > 0) {
    console.log('\nUnknown outlets (not in outlet-registry.json):');
    for (const u of unknownOutlets) {
      console.log(`  ${u.host} — ${u.occurrences} occurrence(s) across ${u.shows.length} show(s): ${u.sampleUrls[0]}`);
    }
  }

  // Collector-outage floor (plan-review 2026-05-31): tolerate one bad URL, but
  // if every attempted article fetch threw, the scraper stack is down — redden
  // CI so a dead Bright Data zone / exhausted SB doesn't masquerade as "no gaps
  // found" (which would silently miss reviews during opening night). Distinct
  // from --fail-on-gap: this fires on infrastructure failure, not on gaps.
  if (_fetchStats.attempts >= 3 && _fetchStats.errors === _fetchStats.attempts) {
    console.error(`::error::collector outage — all ${_fetchStats.errors}/${_fetchStats.attempts} aggregator article fetches threw (Bright Data / ScrapingBee / Playwright all failing). Check BRIGHTDATA_ZONE + ScrapingBee credits; this audit found nothing because nothing could be fetched.`);
    process.exit(1);
  }
  // Discovery-outage floor (ship-check 2026-06-01): the article-fetch floor
  // above only fires once we reach fetching. If SERP discovery itself is down,
  // 0 articles are found, fetching never happens, and the audit would otherwise
  // report "no gaps" during a total blackout. If every SERP query errored,
  // redden. Requires >=3 attempts so a tiny --show run can't false-trigger.
  if (_serpStats.attempts >= 3 && _serpStats.errors === _serpStats.attempts) {
    console.error(`::error::discovery outage — all ${_serpStats.errors}/${_serpStats.attempts} SERP queries errored (SCRAPINGBEE_API_KEY / SERP provider down). No aggregator articles could be discovered; "no gaps" here is meaningless.`);
    process.exit(1);
  }

  // Expected-vs-captured alert (girl-interrupted 2026-06-05): after auto-ingest,
  // surface any show that STILL has roundup-cited reviews we couldn't capture.
  // Unlike check-opening-night-completeness.js (which only detects DISAPPEARANCE
  // vs a prior snapshot), this catches reviews that were never captured at all —
  // absence at first sight. A cited URL is by definition already published, so no
  // settle window is needed. Fires on every run (not just --fail-on-gap) so the
  // hourly cron surfaces residual gaps in the daily digest via ::warning::.
  const residualShows = [];
  for (const r of results) {
    const failedIngest = (r.ingestResults || []).filter(x => !x.ok).length;
    const capped = (r.ingestSkippedByCap || []).length;
    // When --ingest-missing wasn't run, every missing URL is still residual.
    const uningested = ingestMissing ? 0 : r.missing.length;
    const residual = failedIngest + capped + uningested + r.flaggedMisses.length;
    if (residual > 0) {
      residualShows.push({ showId: r.showId, title: r.title, residual, failedIngest, capped, uningested, flaggedOut: r.flaggedMisses.length });
    }
  }
  if (residualShows.length > 0) {
    for (const s of residualShows) {
      console.log(`::warning::review gap — ${s.showId} (${s.title}): ${s.residual} roundup-cited review(s) still uncaptured after auto-ingest (failed=${s.failedIngest} capped=${s.capped} uningested=${s.uningested} flaggedOut=${s.flaggedOut})`);
    }
    console.log(`Expected-vs-captured: ${residualShows.length} show(s) with residual review gaps after auto-ingest.`);
  }

  if (failOnGap && audit.counts.withGap > 0) {
    process.exit(1);
  }
})().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

module.exports = { urlMatchesShow, titleTokens, provisionalOutletIdFromHost };
