#!/usr/bin/env node
/**
 * Opening Night Review Poller
 *
 * Discovers reviews faster than SERP using 4 layers:
 *   1. Aggregators (BWW RR, Show Score, DTLI) — fastest, update within minutes
 *   2. RSS feeds (Variety, NYT, Guardian) — free, no API cost
 *   3. Direct site search (outlet search endpoints) — instant on publish
 *   4. SERP backup (Google via ScrapingBee/BrightData) — catches the rest
 *
 * Each poll cycle discovers new URLs, creates review files, and reports progress.
 * Designed to be called repeatedly by a CI workflow every 15 min on opening night.
 *
 * Usage:
 *   node scripts/opening-night-poller.js --show=show-id-2026
 *   node scripts/opening-night-poller.js --show=show-id-2026 --dry-run
 *   node scripts/opening-night-poller.js --show=show-id-2026 --skip-serp
 *   node scripts/opening-night-poller.js --show=show-id-2026 --skip-site-search
 *   node scripts/opening-night-poller.js --show=show-id-2026 --bww-roundup-url=https://www.broadwayworld.com/article/Review-Roundup-...
 *   node scripts/opening-night-poller.js --show=show-id-2026 --tb-review-url=https://www.talkinbroadway.com/page/world/giant2026.html
 *
 * Environment Variables:
 *   SCRAPINGBEE_API_KEY - For SERP + JS-rendered site search
 *   BRIGHTDATA_TOKEN    - SERP fallback
 */

const fs = require('fs');
const path = require('path');

// Reuse existing infrastructure
const {
  searchDTLI,
  searchShowScore,
  searchBWWRoundup,
  extractDTLIReviews,
  extractShowScoreReviews,
  extractBWWRoundupReviews,
  validateBWWRoundupYear,
  createReviewFile,
  loadShowData,
  gatherReviewsForShow,
} = require('./gather-reviews');

const { checkRSSFeeds } = require('./lib/rss-discovery');
const { searchOutletSites, SITE_SEARCH_ENDPOINTS } = require('./lib/site-search-discovery');
const { discoverCorrectUrl, OUTLET_DOMAINS } = require('./lib/url-discovery');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { isLondonMarket } = require('./lib/venue-classification');
const { llmFallbackExtract, hasStructuralMarkers } = require('./lib/llm-extractor');
const { normalizeOutlet, normalizeUrl: normalizeUrlCanonical } = require('./lib/review-normalization');
const { resolveArchiveRowOutletId } = require('./lib/archive-outlet-identity');
const { extractReviewsFromLBO } = require('./scrape-london-box-office-roundups');
const { extractReviews: extractTheatreReviews } = require('./scrape-theatre-reviews');
const { matchTitleToShow } = require('./lib/show-matching');
const { fetchPage } = require('./lib/scraper');
const { discoverLboRoundupHtml } = require('./lib/lbo-roundup-discover');
const { discoverTrRoundupHtml } = require('./lib/tr-roundup-discover');
const { discoverWetRoundupRows } = require('./lib/wet-roundup-discover');
const { tryTbDirectUrl } = require('./lib/tb-direct-url');
const {
  DEFAULT_SERP_BURST_CONFIG,
  checkSerpBurstAllowed,
  isCascadeTripwireExceeded,
} = require('./lib/serp-burst-caps');
const {
  DEFAULT_SERP_SESSION_CONFIG,
  checkSerpSessionAllowed,
} = require('./lib/serp-session-cap');
const { sendAlert } = require('./lib/discord-notify');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');
const BACKOFF_DIR = path.join(DATA_DIR, 'audit', 'poller-backoff');
const SERP_BURST_LEDGER_PATH = path.join(DATA_DIR, 'audit', 'serp-burst-ledger.json');
const SERP_SESSION_LEDGER_PATH = path.join(DATA_DIR, 'audit', 'serp-session-ledger.json');

/**
 * Balusters postmortem CLASS 7 — exponential backoff for no-op polls.
 *
 * After N consecutive no-op runs, skip the cycle based on schedule:
 *   3 no-ops → next run 30 min out
 *   5 no-ops → next run 60 min out
 *   8+ no-ops → next run 120 min out
 * Aggressive-window carve-out: first 6h after opening we always poll.
 * On any successful discovery, reset the counter.
 */
function loadBackoffState(showId) {
  const p = path.join(BACKOFF_DIR, `${showId}.json`);
  if (!fs.existsSync(p)) return { consecutiveNoOp: 0, lastNewReviewAt: null, nextRunAfter: 0 };
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return { consecutiveNoOp: 0, lastNewReviewAt: null, nextRunAfter: 0 }; }
}

function saveBackoffState(showId, state) {
  if (!fs.existsSync(BACKOFF_DIR)) fs.mkdirSync(BACKOFF_DIR, { recursive: true });
  const p = path.join(BACKOFF_DIR, `${showId}.json`);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

function computeNextBackoffDelayMs(consecutiveNoOp) {
  if (consecutiveNoOp >= 8) return 120 * 60 * 1000;
  if (consecutiveNoOp >= 5) return 60 * 60 * 1000;
  if (consecutiveNoOp >= 3) return 30 * 60 * 1000;
  return 0;
}

function isInAggressiveWindow(show) {
  if (!show.openingDate) return true;
  const hoursSinceOpening = (Date.now() - new Date(show.openingDate).getTime()) / 3600000;
  return hoursSinceOpening >= 0 && hoursSinceOpening < 6;
}

/**
 * Daily ledger for the WE SERP burst (see scripts/lib/serp-burst-caps.js). Provides a
 * best-effort DAILY-GLOBAL + per-show ceiling across independent CI poller runs. Persisted as
 * data/audit/serp-burst-ledger.json in the MAIN repo working tree (tracked in the public repo,
 * NOT the core-data overlay), committed by the workflow's backoff step — the exact same
 * persistence model as poller-backoff state. Resets on UTC date rollover.
 *
 * Concurrency caveat (deliberate, bounded — NOT a hard cross-run guarantee): two WE shows
 * opening the same morning run as parallel poller jobs and share this one ledger. The
 * read-modify-write (plus push-with-retry's "keep local" rebase of audit/) can lose an
 * increment, so the daily ceiling is ADVISORY — under concurrency it can be exceeded by up to
 * ~(Nconcurrent-1) bursts per tick. The TRUE hard bound is the per-cycle SERP_BUDGET (12
 * outlet calls); with realistic concurrency of 2-3 WE openings the worst-case overspend is a
 * few hundred SERP calls/day, nowhere near a cascade. Emergency kill-switch (set the
 * DISABLE_WE_SERP_BURST variable) is the ultimate backstop.
 */
function utcDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function loadSerpBurstLedger(now = new Date()) {
  const today = utcDateKey(now);
  let raw = null;
  try {
    if (fs.existsSync(SERP_BURST_LEDGER_PATH)) {
      raw = JSON.parse(fs.readFileSync(SERP_BURST_LEDGER_PATH, 'utf8'));
    }
  } catch { raw = null; }
  if (!raw || raw.date !== today) {
    return { date: today, globalBursts: 0, perShow: {}, tripwireAlerted: false };
  }
  return {
    date: today,
    globalBursts: raw.globalBursts || 0,
    perShow: raw.perShow || {},
    tripwireAlerted: raw.tripwireAlerted || false,
  };
}

function writeSerpBurstLedger(ledger) {
  try {
    const dir = path.dirname(SERP_BURST_LEDGER_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SERP_BURST_LEDGER_PATH, JSON.stringify(ledger, null, 2));
  } catch (e) {
    console.log(`  [SERP burst] ledger write failed (non-fatal): ${e.message}`);
  }
}

function incrementSerpBurstLedger(showId, now = new Date()) {
  const ledger = loadSerpBurstLedger(now);
  ledger.globalBursts += 1;
  ledger.perShow[showId] = (ledger.perShow[showId] || 0) + 1;
  writeSerpBurstLedger(ledger);
  return ledger;
}

/**
 * Daily ledger for the SERP-SESSION cap (Sprint 1, scripts/lib/serp-session-cap.js).
 * Counts EVERY SERP-running poller cycle (burst or normal), per-show and globally, as a
 * hard daily ceiling so the now-poller-owned SERP (after the Sprint-2 orchestrator-deferral
 * removal) can never run unbounded. Same persistence model as the burst ledger and
 * poller-backoff state: a plain JSON file in the MAIN repo working tree under data/audit/,
 * committed by the workflow's backoff/ledger step, reset on UTC date rollover. Like the
 * burst ledger it is ADVISORY under cross-run concurrency (read-modify-write can lose an
 * increment); the TRUE hard per-cycle bound remains SERP_BUDGET (12 outlet calls).
 */
function loadSerpSessionLedger(now = new Date()) {
  const today = utcDateKey(now);
  let raw = null;
  try {
    if (fs.existsSync(SERP_SESSION_LEDGER_PATH)) {
      raw = JSON.parse(fs.readFileSync(SERP_SESSION_LEDGER_PATH, 'utf8'));
    }
  } catch { raw = null; }
  if (!raw || raw.date !== today) {
    return { date: today, globalSessions: 0, perShow: {} };
  }
  return {
    date: today,
    globalSessions: raw.globalSessions || 0,
    perShow: raw.perShow || {},
  };
}

function writeSerpSessionLedger(ledger) {
  try {
    const dir = path.dirname(SERP_SESSION_LEDGER_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SERP_SESSION_LEDGER_PATH, JSON.stringify(ledger, null, 2));
  } catch (e) {
    console.log(`  [SERP session] ledger write failed (non-fatal): ${e.message}`);
  }
}

function incrementSerpSessionLedger(showId, now = new Date()) {
  const ledger = loadSerpSessionLedger(now);
  ledger.globalSessions += 1;
  ledger.perShow[showId] = (ledger.perShow[showId] || 0) + 1;
  writeSerpSessionLedger(ledger);
  return ledger;
}

// CLI args
const SHOW_ID = (process.argv.find(a => a.startsWith('--show=')) || '').replace('--show=', '');
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_SERP = process.argv.includes('--skip-serp');
const FORCE_SERP = process.argv.includes('--force-serp');
// WE opening-night SERP burst: ON by default (this is an automated system — no human
// watches openings). The burst overrides the orchestrator's iteration-1-8 --skip-serp
// deferral for aggressive-window WE shows, bounded entirely by AUTOMATED safety:
//   - hard daily-global + per-show caps (auto-stop runaway with zero human input)
//   - the existing 3h-post-opening gate
//   - per-cycle SERP_BUDGET (hard per-invocation bound)
//   - it adds SERP calls only inside poller cycles that already run on fixed crons, so it
//     CANNOT trigger a workflow cascade
//   - a tripwire that fires a real owner email (sendAlert) if daily bursts get unusually high
// Emergency kill-switch (rarely needed): gh variable set DISABLE_WE_SERP_BURST --body true
const ENABLE_WE_SERP_BURST = process.env.DISABLE_WE_SERP_BURST !== 'true';
const SKIP_SITE_SEARCH = process.argv.includes('--skip-site-search');
const VERBOSE = process.argv.includes('--verbose') || true; // Always verbose for CI logs
// Escape hatches: bypass SERP discovery when discovery fails (wrong Google result, unindexed page)
// CLI args take priority; falls back to shows.json fields (bwwRoundupUrl, tbReviewUrl)
// so orchestrator-dispatched pollers also get the URL without needing CLI args.
const BWW_ROUNDUP_URL_CLI = (process.argv.find(a => a.startsWith('--bww-roundup-url=')) || '').replace('--bww-roundup-url=', '') || '';
const TB_REVIEW_URL_CLI = (process.argv.find(a => a.startsWith('--tb-review-url=')) || '').replace('--tb-review-url=', '') || '';

// Readiness thresholds — market-aware (must match send-opening-night-broadcast.js)
function getThresholds(market) {
  const isWE = market === 'west-end' || market === 'off-west-end';
  return {
    MIN_REVIEWS: isWE ? 8 : 12,
    MIN_T1_REVIEWS: 3,
    MIN_T2_REVIEWS: isWE ? 2 : 3,
    MIN_HIGH_CONFIDENCE: isWE ? 6 : 8,
  };
}

/**
 * Market-gated + time-tiered polling cadence.
 *
 * Returns one of: 'aggressive' | 'daily' | 'every-3d' | 'weekly' | 'skip'.
 *
 * openingDate is stored as 'YYYY-MM-DD' and parses to UTC-midnight, but actual
 * openings happen in the evening (BW ~23:00 UTC = 7pm ET; WE ~18:30 UTC =
 * 7:30pm BST). The aggressive windows below are therefore expressed as UTC
 * hour-offsets from the parsed midnight that LAND ON the real review-drop
 * window, not nominal "hours post opening":
 *
 *   - Broadway:      h 22-36   → 22 UTC opening day through 12 UTC next day
 *                                (covers 7pm ET opening → next-morning indexing)
 *   - West End:      h 12-30   → noon UTC opening day through 06 UTC next day
 *                                (covers press-night evening + next-morning drops)
 *   - Off-Broadway/Off-West-End: none — reviews trickle over weeks
 *
 * Tiered cadence (SERP gated to morning slot only via shouldRunSerpForMode):
 *   - Days 1-14:     daily
 *   - Days 15-60:    every 3 days
 *   - Days 61-90:    weekly
 *   - Day 90+:       skip
 *   - Pre-opening:   skip if >48h before parsed opening
 *
 * Note: layers 1-3 (aggregators, RSS, SSR site search) still run unless mode='skip'.
 * Only layer 4 (SERP, the expensive BD-backed layer) is gated by mode.
 */
function pollMode(show, now = new Date()) {
  if (!show.openingDate) return 'daily'; // conservative default
  const h = (now.getTime() - new Date(show.openingDate).getTime()) / 3600000;
  const d = h / 24;
  const cat = show.category || show.market || 'broadway';
  const isBW = cat === 'broadway';
  const isWE = cat === 'west-end';

  if (h < -48) return 'skip';
  if (d > 90) return 'skip';

  // Aggressive windows cover the actual review-drop hours.
  // BW reviews drop 01-03 UTC next day (9-11pm ET opening night) → window 22-36
  //   captures the 23:00 + 00:00 + 08:00 UTC cron fires on opening night + next
  //   morning before broadcast.
  // WE reviews drop 06-10 UTC next day (next-morning BST) → window 12-30 captures
  //   the 18:00 UTC press-night evening cron and the 05:00 UTC next-morning cron.
  if (isBW && h >= 22 && h < 36) return 'aggressive';
  if (isWE && h >= 12 && h < 30) return 'aggressive';

  if (d < 14) return 'daily';
  if (d < 60) return 'every-3d';
  return 'weekly';
}

/**
 * Decide whether the expensive SERP layer (Layer 4) should run this cron fire,
 * given the show's poll mode and the current UTC hour.
 *
 * - 'aggressive': always (let the 3h-since-opening gate in pollCycle control freshness)
 * - 'daily':      only on the market's morning-cron slot
 * - 'every-3d':   morning slot AND (daysSinceOpening % 3 === 0)
 * - 'weekly':     morning slot AND (daysSinceOpening % 7 === 0)
 * - 'skip':       never
 *
 * Morning-slot windows account for GitHub cron delay (~1-2h):
 *   BW morning cron at 08:00 UTC fires ~09:00-10:00 UTC → accept 07-13 UTC
 *   WE morning cron at 05:00 UTC fires ~06:00-07:00 UTC → accept 04-09 UTC
 */
function shouldRunSerpForMode(mode, show, now = new Date()) {
  if (mode === 'skip') return false;
  if (mode === 'aggressive') return true;

  const cronHour = now.getUTCHours();
  const cat = show.category || show.market || 'broadway';
  const isWE = cat === 'west-end' || cat === 'off-west-end';
  const inMorningSlot = isWE
    ? (cronHour >= 4 && cronHour <= 9)
    : (cronHour >= 7 && cronHour <= 13);

  if (mode === 'daily') return inMorningSlot;

  if (!show.openingDate) return inMorningSlot;
  const daysSince = Math.floor(
    (now.getTime() - new Date(show.openingDate).getTime()) / 86400000
  );
  if (daysSince < 0) return false;
  if (mode === 'every-3d') return inMorningSlot && (daysSince % 3 === 0);
  if (mode === 'weekly') return inMorningSlot && (daysSince % 7 === 0);
  return false;
}

/**
 * Pre-wipe: mark preview-period files as isPreviewPlaceholder at T-2h.
 *
 * Preview-period SERP/aggregator runs create review files BEFORE opening night
 * that are almost always contamination (preview articles, wrong-production reviews,
 * wrong-year roundups). The flag system catches most of them but leaks ~9%.
 *
 * This function scans the show directory and marks any unscored file modified
 * more than 2 hours BEFORE the show's opening date as a preview placeholder.
 * The post-opening mergeReviews(existing, incoming, {fromPostOpening:true}) path
 * then replaces these files wholesale with fresh post-opening reviews.
 *
 * SAFE: already-scored files (llmScore or humanReviewScore present) are never touched.
 *
 * @param {string} showId
 * @param {string} openingDate - ISO date string (YYYY-MM-DD)
 * @returns {number} count of files marked
 */
function preWipePreOpeningFiles(showId, openingDate) {
  if (!openingDate) return 0;
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return 0;

  const openingMs = new Date(openingDate).getTime();
  // Only mark files modified more than 2h before opening
  const cutoffMs = openingMs - (2 * 60 * 60 * 1000);
  const now = Date.now();

  // Only run within 36h window before opening (don't wipe historical shows)
  if (now < openingMs - (36 * 60 * 60 * 1000)) return 0;
  // Don't run if opening was more than 7 days ago (past opening window)
  if (now > openingMs + (7 * 24 * 60 * 60 * 1000)) return 0;

  let marked = 0;
  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
    try {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      // Never touch already-scored files
      if ((data.llmScore && data.llmScore.score != null) || data.humanReviewScore != null) continue;
      // Never touch human-flagged files
      if (data.humanReviewedWrongProduction != null || data.wrongShowReason) continue;
      // Never touch already-marked files
      if (data.isPreviewPlaceholder) continue;

      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoffMs) {
        const hoursBeforeOpening = Math.round((openingMs - stat.mtimeMs) / 3600000);
        data.isPreviewPlaceholder = true;
        data.previewPlaceholderReason = `Pre-wipe: file modified ${hoursBeforeOpening}h before opening`;
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        marked++;
        console.log(`  [PRE-WIPE] ${file} → isPreviewPlaceholder (modified ${hoursBeforeOpening}h before opening)`);
      }
    } catch (e) { /* skip unreadable files */ }
  }
  if (marked > 0) {
    console.log(`  Pre-wipe: marked ${marked} preview-period files as placeholders`);
  }
  return marked;
}

// S1-T5: discovery-unblock window. A file only stops suppressing rediscovery
// via the canonical isRejectedNonReview path when its show is within ±45d of
// previews/opening AND the outlet is T1/T2 — this bounds the SERP-volume blast
// radius (dry-run measured 1 newly-unblocked cell corpus-wide). Outside the
// window / for T3+ outlets, the historical skip conditions apply unchanged.
const DISCOVERY_UNBLOCK_WINDOW_DAYS = 45;
function isInDiscoveryUnblockWindow(show, nowMs = Date.now()) {
  if (!show) return false;
  const anchor = show.previewsStartDate || show.openingDate;
  if (!anchor) return true; // dateless active show — poller only runs on live shows
  const ms = new Date(anchor).getTime();
  if (isNaN(ms)) return true;
  return Math.abs(nowMs - ms) <= DISCOVERY_UNBLOCK_WINDOW_DAYS * 86400000;
}

/**
 * Get all known URLs for a show (from existing review-text files on disk).
 * @param {string} showId
 * @param {{show?: object, market?: string}} [ctx] - when provided, in-window
 *   T1/T2 rejected-non-review files (interview/feature/preview/news, garbage,
 *   invalid tier) also stop blocking rediscovery (S1-T5). Omit for the historical
 *   behavior (used by non-poller callers).
 */
function getKnownUrls(showId, ctx) {
  const urls = new Set();
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return urls;

  const scoped = !!(ctx && ctx.show && isInDiscoveryUnblockWindow(ctx.show));
  let isRejectedNonReview, getTier, showCategory;
  if (scoped) {
    ({ isRejectedNonReview } = require('./lib/review-guards'));
    ({ getTier } = require('./lib/outlet-tiers'));
    showCategory = isLondonMarket(ctx.market) ? 'west-end' : 'broadway';
  }

  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      // Skip wrongProduction/wrongShow files — their URLs shouldn't block fresh discovery
      // EXCEPTION: if the file is already scored (llmScore present), the wrongProduction flag
      // may be a false-positive from LLM contentVerification (44% FP on opening night).
      // Keep scored files in knownUrls so their URLs don't get re-discovered and clobber them.
      // (Proof 2026-04-17 P0: LLM FP set wrongProduction → URL excluded → second run clobbered 9 reviews)
      const isScored = (data.llmScore && data.llmScore.score != null) || data.humanReviewScore != null;
      // Skip preview placeholders — post-opening discoveries must be allowed to replace them
      // Skip confirmed non-reviews — interviews/news/previews should not block the real review URL
      if ((data.wrongProduction || data.wrongShow) && !isScored) continue;
      if (data.isPreviewPlaceholder || data.rejectionReason === 'not_a_review') continue;
      // S1-T5: in-window T1/T2 — a rejected NON-review occupying the outlet slot
      // must not block the real review's URL. Guarded by !isScored so the
      // scored-wrongProd-FP carve-out above is preserved (isRejectedNonReview
      // also excludes wrongProduction/wrongShow by construction).
      if (scoped && !isScored && data.outletId
          && getTier(data.outletId.toLowerCase(), { showCategory }) <= 2
          && isRejectedNonReview(data)) continue;
      if (data.url) urls.add(data.url);
      if (data.reviewUrl) urls.add(data.reviewUrl);
    } catch {}
  }
  return urls;
}

/**
 * Get found outlet IDs for a show (from existing review-text files).
 * @param {string} showId
 * @param {{show?: object, market?: string}} [ctx] - see getKnownUrls (S1-T5).
 */
function getFoundOutletIds(showId, ctx) {
  const outletIds = new Set();
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return outletIds;

  const scoped = !!(ctx && ctx.show && isInDiscoveryUnblockWindow(ctx.show));
  let isRejectedNonReview, getTier, showCategory;
  if (scoped) {
    ({ isRejectedNonReview } = require('./lib/review-guards'));
    ({ getTier } = require('./lib/outlet-tiers'));
    showCategory = isLondonMarket(ctx.market) ? 'west-end' : 'broadway';
  }

  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      // Skip wrongProduction/wrongShow files — they shouldn't block re-discovery
      // Skip confirmed non-reviews (interviews, news, previews) — same reason
      if (data.wrongProduction || data.wrongShow || data.rejectionReason === 'not_a_review') continue;
      // S1-T5: in-window T1/T2 — reopen discovery for a rejected non-review
      // (garbage / invalid tier / CV interview-feature-preview-news) so its
      // outlet slot doesn't read as "found". !isScored preserves the scored-
      // wrongProd carve-out (isRejectedNonReview excludes wrongProduction).
      if (scoped && data.outletId) {
        const isScored = (data.llmScore && data.llmScore.score != null) || data.humanReviewScore != null;
        if (!isScored && getTier(data.outletId.toLowerCase(), { showCategory }) <= 2
            && isRejectedNonReview(data)) continue;
      }
      if (data.outletId) outletIds.add(data.outletId.toLowerCase());
    } catch {}
  }
  return outletIds;
}

/**
 * Get T1/T2 outlets that haven't been found yet for a show.
 * v5 (2026-04-29): use region-aware getTier() so per-region tiers from
 * outlet-tiers.json (e.g. NYT T2 in London, The Stage T1 in London) override
 * the registry's plain `tier` field. Without this, opening-night discovery
 * would treat NYT as T1 for West End shows even though it's effectively T2
 * cross-coverage.
 */
function getMissingT1T2Outlets(showId, market, show) {
  const registry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;
  const foundIds = getFoundOutletIds(showId, { show, market });

  const { getTier } = require('./lib/outlet-tiers');
  // Map market to showCategory for tier lookup
  const showCategory = isLondonMarket(market) ? 'west-end' : 'broadway';

  const missing = [];
  for (const [outletId, outlet] of Object.entries(outlets)) {
    const effectiveTier = getTier(outletId, { showCategory });
    if (effectiveTier > 2) continue;
    if (foundIds.has(outletId.toLowerCase())) continue;
    // Market filter
    if (isLondonMarket(market) && !outlet.isDualMarket && outlet.region !== 'uk') continue;
    if (market === 'broadway' && outlet.region === 'uk' && !outlet.isDualMarket) continue;
    missing.push({ id: outletId, name: outlet.displayName || outletId, tier: effectiveTier, domain: outlet.domain, isDualMarket: !!outlet.isDualMarket });
  }

  return missing.sort((a, b) => a.tier - b.tier); // T1 first
}

/**
 * Check readiness for broadcast
 */
function checkReadiness(showId, market = 'broadway') {
  const { MIN_REVIEWS, MIN_T1_REVIEWS, MIN_T2_REVIEWS, MIN_HIGH_CONFIDENCE } = getThresholds(market);
  const reviews = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;
  const arr = Array.isArray(reviews.reviews || reviews) ? (reviews.reviews || reviews) : Object.values(reviews.reviews || reviews);

  const showRevs = arr.filter(r => r.showId === showId && r.assignedScore > 0);
  const t1 = showRevs.filter(r => { const o = outlets[r.outletId]; return o && o.tier === 1; }).length;
  const t2 = showRevs.filter(r => { const o = outlets[r.outletId]; return o && o.tier === 2; }).length;
  const hiConf = showRevs.filter(r => r.scoreConfidence === 'high' || r.scoreConfidence === 'medium').length;

  return {
    total: showRevs.length,
    t1,
    t2,
    highConfidence: hiConf,
    ready: showRevs.length >= MIN_REVIEWS && t1 >= MIN_T1_REVIEWS && t2 >= MIN_T2_REVIEWS && hiConf >= MIN_HIGH_CONFIDENCE,
    reasons: [
      showRevs.length < MIN_REVIEWS ? `${showRevs.length}/${MIN_REVIEWS} total` : null,
      t1 < MIN_T1_REVIEWS ? `T1:${t1}/${MIN_T1_REVIEWS}` : null,
      t2 < MIN_T2_REVIEWS ? `T2:${t2}/${MIN_T2_REVIEWS}` : null,
      hiConf < MIN_HIGH_CONFIDENCE ? `hi-conf:${hiConf}/${MIN_HIGH_CONFIDENCE}` : null,
    ].filter(Boolean),
  };
}

/**
 * Run Layer 1: Aggregators
 * Calls the existing aggregator functions from gather-reviews.js
 */
async function runAggregators(show) {
  console.log('\n[Layer 1] Aggregators...');
  const results = [];
  const year = new Date(show.openingDate).getFullYear();
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);

  // 1a. DTLI (Broadway/OB only — DTLI doesn't cover London)
  if (!isWestEnd) {
    try {
      console.log('  Checking DTLI...');
      const dtli = await searchDTLI(show);
      if (dtli && dtli.html) {
        const validation = await validatePageMatchesShow(dtli.html, show.title, {
          openingYear: year,
        });
        if (validation.valid) {
          let reviews = extractDTLIReviews(dtli.html, show.id, dtli.url, show.title);
          if (reviews.length === 0 && hasStructuralMarkers(dtli.html, 'dtli')) {
            reviews = await llmFallbackExtract(dtli.html, {
              aggregator: 'dtli', showTitle: show.title, showId: show.id,
            });
          }
          console.log(`  DTLI: ${reviews.length} reviews found`);
          results.push(...reviews);
        } else {
          console.log(`  DTLI: page mismatch — ${validation.reason}`);
        }
      } else {
        console.log('  DTLI: not found');
      }
    } catch (err) {
      console.log(`  DTLI error: ${err.message}`);
    }
  } else {
    console.log('  DTLI: skipped (London market — DTLI is US-only)');
  }

  // 1b. Show Score
  try {
    console.log('  Checking Show Score...');
    const ss = await searchShowScore(show);
    if (ss && ss.html) {
      const validation = await validatePageMatchesShow(ss.html, show.title, {
        openingYear: year,
      });
      if (validation.valid) {
        // Playwright-extracted reviews take priority
        if (ss.reviews && ss.reviews.length > 0) {
          console.log(`  Show Score: ${ss.reviews.length} reviews (Playwright): ${ss.reviews.map(r => r.outlet || 'unknown').join(', ')}`);
          for (const r of ss.reviews) {
            results.push({
              showId: show.id,
              outletId: r.outlet ? r.outlet.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'unknown',
              outlet: r.outlet || 'Unknown',
              criticName: r.critic || 'Unknown',
              url: r.url,
              excerpt: r.excerpt,
              publishDate: r.date,
              source: 'show-score',
            });
          }
        } else {
          const reviews = extractShowScoreReviews(ss.html, show.id, show.title);
          console.log(`  Show Score: ${reviews.length} reviews (HTML)`);
          results.push(...reviews);
        }
      } else {
        console.log(`  Show Score: page mismatch — ${validation.reason}`);
      }
    } else {
      console.log('  Show Score: not found');
    }
  } catch (err) {
    console.log(`  Show Score error: ${err.message}`);
  }

  // 1c. BWW Review Roundup (skip for off-Broadway; skip URL guessing for WE — BWW RR rare for WE)
  // For WE: only check if a manual --bww-roundup-url is provided (bypass discovery entirely)
  // Resolve BWW RR URL: CLI arg > shows.json field > reviews.php listing (Browserbase) > SERP fallback
  let BWW_ROUNDUP_URL = BWW_ROUNDUP_URL_CLI || show.bwwRoundupUrl || '';
  let bwwResolvedVia = BWW_ROUNDUP_URL_CLI ? 'CLI' : (show.bwwRoundupUrl ? 'shows.json' : null);

  // Primary auto-discovery for Broadway AND off-Broadway. OB roundups live on
  // BWW's /off-broadway/ section page (cheap ScrapingBee scan, no Browserbase) —
  // discoverBwwRoundupUrl tries that first, then falls back to reviews.php
  // (Browserbase) for Broadway. SERP/Google indexing lags BWW publication by
  // 1-6 hours; the listing pages update within minutes. Pre-2026-06-06 OB was
  // skipped here entirely, so off-Broadway roundups (Girl, Interrupted /
  // A Woman Among Women) were only ever found via flaky Google SERP.
  if (!BWW_ROUNDUP_URL && !isWestEnd) {
    const browserbaseReady = process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID;
    // reviews.php (the Broadway fallback) needs Browserbase; the OB section scan
    // does not — only fail-loud about missing Browserbase when it actually matters.
    if (!browserbaseReady && !isOffBroadway) {
      // Silent skip on missing secrets is the Beaches-2026-04-22 failure mode —
      // poller falls through to SERP/URL-guessing which hits wrong/unpublished URLs.
      console.log('::warning::BWW reviews.php discovery SKIPPED — BROWSERBASE_API_KEY or BROWSERBASE_PROJECT_ID missing from env. Set secrets on this workflow.');
    } else {
      // T6 negative-cache check: skip discovery entirely if this show is in
      // miss cooldown (opening-window shows are always exempt — see
      // bww-roundup-persistence.js). Wrapped so a ledger read failure never
      // blocks discovery — worst case is a redundant fetch, not a missed one.
      let skipViaCooldown = false;
      try {
        const { readRoundupMisses, lastMissForShow, isInRoundupMissCooldown } = require('./lib/bww-roundup-persistence.js');
        const lastMiss = lastMissForShow(show.id, readRoundupMisses());
        skipViaCooldown = isInRoundupMissCooldown(show, lastMiss);
        if (skipViaCooldown) {
          console.log(`  BWW discovery: skipped (miss cooldown active, last miss ${lastMiss.ts})`);
        }
      } catch { /* never block discovery on a ledger read failure */ }

      if (!skipViaCooldown) {
        try {
          const { discoverBwwRoundupUrl } = require('./lib/bww-rr-discover.js');
          console.log('  Trying BWW roundup discovery (section scan → reviews.php)...');
          const discovery = await discoverBwwRoundupUrl(show);
          if (discovery.url) {
            BWW_ROUNDUP_URL = discovery.url;
            bwwResolvedVia = discovery.via || 'bww-discover';
            console.log(`  BWW RR URL auto-discovered (${bwwResolvedVia}): ${BWW_ROUNDUP_URL}`);
            try {
              const { persistBwwRoundupUrlIfMissing } = require('./lib/bww-roundup-persistence.js');
              persistBwwRoundupUrlIfMissing(show.id, BWW_ROUNDUP_URL);
            } catch (persistErr) {
              console.log(`::warning::BWW roundup URL persistence failed (non-fatal): ${persistErr.message}`);
            }
          } else {
            const tried = (discovery.candidates || []).length;
            console.log(`  BWW discovery: no matching RR (${tried} anchors seen, 0 matched show) — falling through to SERP/guessing`);
            try {
              const { recordRoundupMiss } = require('./lib/bww-roundup-persistence.js');
              recordRoundupMiss(show.id);
            } catch { /* ledger append failure is never fatal to discovery */ }
          }
        } catch (err) {
          console.log(`::warning::BWW discovery error (falling through to SERP): ${err.message}`);
        }
      }
    }
  }

  if (!isWestEnd || BWW_ROUNDUP_URL) {
    try {
      if (BWW_ROUNDUP_URL) console.log(`  BWW RR URL: ${BWW_ROUNDUP_URL} (${bwwResolvedVia || 'SERP'})`);
      console.log('  Checking BWW Review Roundup...');
      // Pass runtime override when reviews.php/SERP discovery fails.
      const bwwOptions = BWW_ROUNDUP_URL ? { overrideUrl: BWW_ROUNDUP_URL } : {};
      const bww = await searchBWWRoundup(show, year, bwwOptions);
      if (bww && bww.html) {
        let reviews = extractBWWRoundupReviews(bww.html, show.id, bww.url, show.title);
        if (reviews.length === 0 && hasStructuralMarkers(bww.html, 'bww')) {
          reviews = await llmFallbackExtract(bww.html, {
            aggregator: 'bww', showTitle: show.title, showId: show.id,
          });
        }
        // Validate roundup year — reject if from older production (e.g., OB roundup for Broadway show)
        reviews = validateBWWRoundupYear(reviews, bww.html, show.openingDate, show.id, bww.url);
        console.log(`  BWW RR: ${reviews.length} reviews found`);
        results.push(...reviews);
      } else {
        console.log('  BWW RR: not found');
        // T6 revalidation: the URL fetch/verify came from a PERSISTED
        // shows.json field (not a fresh discovery this run) and failed —
        // most likely the page 404s now. Clear it so the next poll
        // rediscovers instead of retrying a dead URL forever.
        if (bwwResolvedVia === 'shows.json') {
          try {
            const { clearStaleBwwRoundupUrl } = require('./lib/bww-roundup-persistence.js');
            clearStaleBwwRoundupUrl(show.id);
            console.log('  BWW RR: cleared stale persisted bwwRoundupUrl for rediscovery');
          } catch { /* revalidation failure is never fatal */ }
        }
      }
    } catch (err) {
      console.log(`  BWW RR error: ${err.message}`);
    }
  }

  // 1d. Playbill Verdict (Broadway + off-Broadway + WE — Playbill covers all three).
  //
  // Hits playbill.com/category/the-verdict and matches the article title
  // against this specific show. Bridges a gap where the batch scraper
  // (scrape-playbill-verdict.js, runs on its own cron) rejects medium-confidence
  // matches against the 700-show corpus; per-show polling is narrow enough to
  // trust medium matches, so long article titles like "Reviews: What Do the
  // Critics Think of {Show} on Broadway?" land here instead of waiting for SERP.
  // Shared helpers live in scripts/lib/playbill-verdict-discover.js — the batch
  // scraper still owns file creation + archiving.
  try {
    console.log('  Checking Playbill Verdict...');
    const {
      searchPlaybillVerdict,
      extractReviewLinksFromArticle,
    } = require('./lib/playbill-verdict-discover');
    const hit = await searchPlaybillVerdict(show);
    if (hit && hit.articleUrl) {
      console.log(`  Playbill Verdict article: ${hit.articleUrl}`);
      const articleFetch = await fetchPage(hit.articleUrl, { skipVerify: true });
      if (articleFetch && articleFetch.content) {
        const links = extractReviewLinksFromArticle(articleFetch.content, show.id);
        // resolveOutletFromUrl lives in review-normalization; using it here
        // sets outletId up-front so processDiscoveredReviews doesn't have to
        // fall back to a slugified domain (which misses aliases — e.g.
        // 'nytimes-com' vs registry's 'nytimes').
        let resolveOutletFromUrl;
        try {
          ({ resolveOutletFromUrl } = require('./lib/review-normalization'));
        } catch { /* best-effort resolution; fallback handles null */ }
        let converted = 0;
        for (const link of links) {
          const resolved = resolveOutletFromUrl ? (resolveOutletFromUrl(link.url) || null) : null;
          results.push({
            showId: show.id,
            outletId: resolved?.outletId
              || (link.outletDomain ? link.outletDomain.replace(/\./g, '-') : 'unknown'),
            outlet: resolved?.outletName || link.outlet || link.outletDomain || 'Unknown',
            criticName: link.critic || 'Unknown',
            url: link.url,
            source: 'playbill-verdict',
          });
          converted++;
        }
        console.log(`  Playbill Verdict: ${converted} review link(s) extracted from "${hit.articleTitle.slice(0, 80)}"`);
      } else {
        console.log('  Playbill Verdict: article fetch returned no content');
      }
    } else {
      console.log('  Playbill Verdict: no matching article on the category page');
    }
  } catch (err) {
    console.log(`  Playbill Verdict error: ${err.message}`);
  }

  // 1c2. Talkin' Broadway direct URL (Broadway only, not off-Broadway)
  // SERP returns forum posts (All That Chat) instead of the review, so we construct the URL.
  // Verification (title match + byline + date window) lives in scripts/lib/tb-direct-url.js
  // so the gate is tight enough to reject soft-404s and old-production revival pages.
  if (!isOffBroadway && !isWestEnd) {
    try {
      const showReviewDir = path.join(REVIEW_TEXTS_DIR, show.id);
      const tbFiles = fs.existsSync(showReviewDir)
        ? fs.readdirSync(showReviewDir).filter(f => f.startsWith('talkinbroadway--'))
        : [];
      // Stale-URL guard: if every existing TB file has an empty URL OR its URL
      // doesn't match TB's canonical CamelCase format (/page/world/CamelCase.html
      // or /page/world/CamelCase2026.html), treat it as "no good URL yet" and
      // re-run discovery. FA had fallenangels2026.html hand-entered but TB
      // published it as FallenAngels.html — lowercased slugs are 404s on TB.
      // Regex requires first slug char to be uppercase (TB's actual URL convention).
      const TB_URL_PATTERN = /^https?:\/\/(www\.)?talkinbroadway\.com\/page\/world\/[A-Z][A-Za-z0-9]*\.html$/;
      const looksOk = (url) => typeof url === 'string' && url && TB_URL_PATTERN.test(url);
      let anyGoodUrl = false;
      for (const f of tbFiles) {
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(showReviewDir, f), 'utf8'));
          if (looksOk(rec.url)) { anyGoodUrl = true; break; }
        } catch { /* ignore parse errors, treat as no good URL */ }
      }
      const hasTbReview = tbFiles.length > 0 && anyGoodUrl;
      if (tbFiles.length > 0 && !anyGoodUrl) {
        console.log(`  Talkin' Broadway: ${tbFiles.length} existing file(s) but URL looks stale/invalid — re-running discovery`);
      }
      if (hasTbReview) {
        console.log('  Talkin\' Broadway: already have review file, skipping');
      } else {
        const overrideUrl = TB_REVIEW_URL_CLI || show.tbReviewUrl || '';
        const isRevival = !!(show.isRevival || (show.id && /\b(19|20)\d{2}\b/.test(show.id)));
        const tb = await tryTbDirectUrl({
          show,
          year,
          overrideUrl,
          fetchPage,
          isRevival,
        });
        if (tb.found) {
          results.push({
            showId: show.id,
            outletId: 'talkinbroadway',
            outlet: "Talkin' Broadway",
            criticName: 'Unknown',
            url: tb.url,
            source: tb.source,
            ...(tb.publishDate ? { publishDate: tb.publishDate } : {}),
          });
        } else {
          console.log(`  Talkin' Broadway: ${tb.reason} — review may not be published yet`);
        }
      }
    } catch (err) {
      console.log(`  Talkin' Broadway error: ${err.message}`);
    }
  }

  // 1d. London Box Office roundups (WE/OWE only)
  // Discovery (curated map → archive → sitemap, title-validated) extracted to
  // lib/lbo-roundup-discover.js (2026-07-10) so the review-gap audit shares it.
  if (isWestEnd) {
    try {
      console.log('  Checking London Box Office roundup...');
      const lbo = await discoverLboRoundupHtml(show, { dataDir: DATA_DIR });
      if (lbo) {
        const lboReviews = extractReviewsFromLBO(lbo.html, show.id);
        console.log(`  LBO: ${lboReviews.length} reviews found`);
        for (const r of lboReviews) {
          results.push({
            showId: show.id,
            outletId: resolveArchiveRowOutletId({ url: r.url, outletLabel: r.outlet, cachedOutletId: r.outletId, sourceOutletId: 'london-box-office' }),
            outlet: r.outlet || 'Unknown',
            criticName: r.critic || 'Unknown',
            url: r.url || '',
            excerpt: r.excerpt || '',
            score: r.score,
            scoreSource: r.score !== null ? 'lbo-star-rating' : undefined,
            source: 'lbo-roundup',
          });
        }
      } else {
        console.log('  LBO: no roundup found');
      }
    } catch (err) {
      console.log(`  LBO error: ${err.message}`);
    }
  }

  // 1e. theatre.reviews roundups (WE/OWE only — best structured WE aggregator)
  // Discovery (bounded URL construction → WP-API, cross-show-guarded) extracted
  // to lib/tr-roundup-discover.js (2026-07-10) so the review-gap audit shares it.
  if (isWestEnd) {
    try {
      console.log('  Checking theatre.reviews...');
      const tr = await discoverTrRoundupHtml(show);
      if (tr) {
        // Cache to archive for future runs
        const archivePath = path.join(DATA_DIR, 'aggregator-archive', 'theatre-reviews', `${show.id}.html`);
        if (!fs.existsSync(path.dirname(archivePath))) fs.mkdirSync(path.dirname(archivePath), { recursive: true });
        fs.writeFileSync(archivePath, tr.html);

        const trReviews = extractTheatreReviews(tr.html, show.id);
        console.log(`  theatre.reviews: ${trReviews.length} reviews found`);
        for (const r of trReviews) {
          results.push({
            showId: show.id,
            outletId: resolveArchiveRowOutletId({ url: r.url, outletLabel: r.outlet, cachedOutletId: r.outletId }),
            outlet: r.outlet || 'Unknown',
            criticName: r.critic || 'Unknown',
            url: r.url || '',
            excerpt: r.excerpt || '',
            // TR rates shows independently — don't use as outlet's score
            theatreReviewsStars: r.stars ? `${r.stars}/${r.starsOutOf || 5}` : undefined,
            source: 'theatre-reviews',
          });
        }
      } else {
        console.log('  theatre.reviews: no roundup found');
      }
    } catch (err) {
      console.log(`  theatre.reviews error: ${err.message}`);
    }
  }

  // 1f. Stagedoor critic reviews (WE/OWE only — needs archive, can't fetch live due to Cloudflare)
  if (isWestEnd) {
    try {
      console.log('  Checking Stagedoor archive...');
      const sdArchivePath = path.join(DATA_DIR, 'aggregator-archive', 'stagedoor', `${show.id}.json`);
      if (fs.existsSync(sdArchivePath)) {
        const sdData = JSON.parse(fs.readFileSync(sdArchivePath, 'utf8'));
        const sdReviews = sdData.criticReviews || [];
        console.log(`  Stagedoor: ${sdReviews.length} reviews from archive`);
        for (const r of sdReviews) {
          results.push({
            showId: show.id,
            outletId: normalizeOutlet(r.outlet || ''),
            outlet: r.outlet || 'Unknown',
            criticName: 'Unknown', // Stagedoor doesn't provide critic names
            url: '',
            excerpt: r.excerpt || '',
            score: r.stars ? Math.round((r.stars / 5) * 100) : null,
            scoreSource: r.stars ? 'stagedoor-star-rating' : undefined,
            source: 'stagedoor',
          });
        }
      } else {
        console.log('  Stagedoor: no archive found');
      }
    } catch (err) {
      console.log(`  Stagedoor error: ${err.message}`);
    }
  }

  // 1g. WestEndTheatre.com roundups (WE/OWE only — WP API + rendered page fallback)
  // Discovery + dual-format row extraction extracted to lib/wet-roundup-discover.js
  // (2026-07-10) so the review-gap audit shares it. This block keeps: archive
  // marker write, per-row URL-date validation, results mapping (wetStars policy).
  if (isWestEnd) {
    try {
      console.log('  Checking WestEndTheatre.com (WP API)...');
      const wet = await discoverWetRoundupRows(show);
      if (wet) {
        const { rows: wetReviews, post } = wet;
        console.log(`  WestEndTheatre: ${wetReviews.length} ratings found`);

        // Archive
        const wetArchiveDir = path.join(DATA_DIR, 'aggregator-archive', 'westendtheatre');
        if (!fs.existsSync(wetArchiveDir)) fs.mkdirSync(wetArchiveDir, { recursive: true });
        fs.writeFileSync(path.join(wetArchiveDir, `${show.id}.json`),
          JSON.stringify({ ourShowId: show.id, wpPostId: post.id, fetchedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');

        for (const r of wetReviews) {
          // Validate URL date: extract date from URL slug and reject if >60 days before opening
          let urlDate = null;
          if (r.url) {
            // Common UK URL date patterns: /2026/mar/26/ or /2026-03-26/ or /2026/03/26/
            const dateMatch = r.url.match(/\/(\d{4})\/(\w{3}|\d{2})\/(\d{1,2})\//);
            if (dateMatch) {
              const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
              const y = parseInt(dateMatch[1]);
              const m = months[dateMatch[2].toLowerCase()] ?? (parseInt(dateMatch[2]) - 1);
              const d = parseInt(dateMatch[3]);
              if (!isNaN(y) && !isNaN(m) && !isNaN(d)) urlDate = new Date(y, m, d);
            }
          }
          const openingMs = show.openingDate ? new Date(show.openingDate).getTime() : null;
          if (urlDate && openingMs && (openingMs - urlDate.getTime()) > 60 * 86400000) {
            console.log(`    ✗ Rejecting ${r.outlet} URL: date ${urlDate.toISOString().slice(0,10)} is >60 days before opening ${show.openingDate}`);
            // Clear the bad URL so it falls back to the roundup post link
            r.url = '';
          }
          results.push({
            showId: show.id,
            outletId: resolveArchiveRowOutletId({ url: r.url || post.link, outletLabel: r.outlet, sourceOutletId: 'westendtheatre' }),
            outlet: r.outlet,
            criticName: r.critic,
            url: r.url || post.link || '',
            excerpt: '',
            // WET rates shows independently — don't use as outlet's score
            wetStars: r.stars ? `${r.stars}/5` : undefined,
            source: 'westendtheatre',
            // Pass roundup post date so createReviewFile can validate against opening date
            publishDate: post.date || undefined,
          });
        }
      } else {
        console.log('  WestEndTheatre: no matching roundup');
      }
    } catch (err) {
      console.log(`  WestEndTheatre error: ${err.message}`);
    }
  }

  // 1h. The Stage roundups (WE/OWE only — archive first, live fetch via BrowserBase if available)
  if (isWestEnd) {
    try {
      console.log('  Checking The Stage...');
      const { extractReviews: extractStageReviews } = require('./scrape-thestage-roundups');
      const tsArchiveDir = path.join(DATA_DIR, 'aggregator-archive', 'thestage-roundups');
      const tsArchivePath = path.join(tsArchiveDir, `${show.id}.html`);
      let tsHtml = null;

      // Try archive first
      if (fs.existsSync(tsArchivePath)) {
        tsHtml = fs.readFileSync(tsArchivePath, 'utf8');
        console.log('  The Stage: found archive');
      }

      // Live fetch via BrowserBase if no archive and cookies are present
      const { loadCookiesForDomain: loadStageCookies } = require('./lib/cookie-loader');
      const stageCookies = loadStageCookies('thestage.co.uk');
      if (!tsHtml && process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID
          && stageCookies) {
        console.log('  The Stage: no archive — attempting live fetch via BrowserBase (cookie auth)...');
        try {
          const { chromium } = require('playwright');
          const https = require('https');

          // Create BrowserBase session
          const bbApiKey = process.env.BROWSERBASE_API_KEY;
          const bbProjectId = process.env.BROWSERBASE_PROJECT_ID;
          const sessionBody = JSON.stringify({
            projectId: bbProjectId,
            browserSettings: { solveCaptchas: true },
          });
          const session = await new Promise((resolve, reject) => {
            const req = https.request('https://www.browserbase.com/v1/sessions', {
              method: 'POST',
              headers: { 'x-bb-api-key': bbApiKey, 'Content-Type': 'application/json' },
            }, (res) => {
              let d = '';
              res.on('data', c => d += c);
              res.on('end', () => {
                try { resolve(JSON.parse(d)); }
                catch (e) { reject(new Error(`BrowserBase API returned non-JSON: ${d.slice(0, 200)}`)); }
              });
            });
            req.on('error', reject);
            req.end(sessionBody);
          });

          if (!session || !session.id) {
            throw new Error(`BrowserBase session creation failed: ${JSON.stringify(session).slice(0, 200)}`);
          }

          const connectUrl = `wss://connect.browserbase.com?apiKey=${bbApiKey}&sessionId=${session.id}`;
          const browser = await chromium.connectOverCDP(connectUrl);
          try {
            const context = browser.contexts()[0] || await browser.newContext();
            const page = context.pages()[0] || await context.newPage();

            // Inject cookies instead of logging in (avoids creating new sessions)
            const pwCookies = stageCookies.map(c => ({
              name: c.name, value: c.value,
              domain: c.domain || '.thestage.co.uk',
              path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
              ...(c.sameSite ? { sameSite: c.sameSite } : {}),
            }));
            await context.addCookies(pwCookies);
            console.log('  The Stage: cookies injected');

            // Navigate to listing and discover the roundup URL for this show
            // Stage URLs are unpredictable (include venue, creative team) — must discover, not construct
            await page.goto('https://www.thestage.co.uk/review-round-ups/review-round-ups', {
              waitUntil: 'networkidle', timeout: 30000,
            });
            await page.waitForTimeout(3000);

            // Extract all roundup links and find one matching our show title
            // Uses matchTitleToShow (same fuzzy matching as weekly scraper) for robustness
            const allLinks = await page.$$eval('a[href*="/review-round-ups/"]', (anchors) => {
              return anchors.map(a => ({
                href: a.href,
                text: a.textContent.trim(),
              })).filter(l =>
                l.href.includes('-review-round-up') &&
                !l.href.endsWith('/review-round-ups') &&
                !l.href.includes('/review-round-ups/review-round-ups')
              );
            });

            let roundupUrl = null;
            for (const link of allLinks) {
              // Try matching link text against our show
              const textMatch = matchTitleToShow(link.text, [show], { market: 'west-end' });
              if (textMatch && textMatch.show) {
                roundupUrl = link.href;
                break;
              }
              // Also try extracting title from URL slug (strips venue info like the weekly scraper)
              const slug = link.href.match(/review-round-ups\/(.+?)(?:-review-round-up)?\/?$/)?.[1] || '';
              const slugTitle = slug
                .replace(/-review-round-up$/, '')
                .replace(/-at-the-.*$/, '').replace(/-at-.*$/, '')
                .split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              if (slugTitle) {
                const slugMatch = matchTitleToShow(slugTitle, [show], { market: 'west-end' });
                if (slugMatch && slugMatch.show) {
                  roundupUrl = link.href;
                  break;
                }
              }
            }

            if (!roundupUrl) {
              console.log(`  The Stage: no matching roundup found on listing page (${allLinks.length} links checked)`);
            } else {
              console.log(`  The Stage: found roundup → ${roundupUrl}`);

              // Step 3: Fetch the roundup page
              await page.goto(roundupUrl, { waitUntil: 'networkidle', timeout: 30000 });
              await page.waitForTimeout(3000);

              tsHtml = await page.content();

              // Guard: don't archive paywalled/truncated content
              // Real roundups have star ratings (★ or *) in the content
              const hasStars = tsHtml && (tsHtml.includes('★') || /\*{2,5}/.test(tsHtml));
              const hasPaywall = tsHtml && (tsHtml.includes('create a free account') || tsHtml.includes('Subscribe to continue'));

              if (tsHtml && hasStars && !hasPaywall && tsHtml.length > 2000) {
                if (!fs.existsSync(tsArchiveDir)) fs.mkdirSync(tsArchiveDir, { recursive: true });
                fs.writeFileSync(tsArchivePath, tsHtml);
                console.log('  The Stage: live fetch successful, archived');
              } else if (hasPaywall) {
                console.log('  The Stage: page is paywalled (login may have failed), skipping archive');
                tsHtml = null;
              } else {
                console.log(`  The Stage: content looks incomplete (stars=${!!hasStars}, len=${tsHtml?.length || 0}), skipping archive`);
                tsHtml = null;
              }
            }
          } finally {
            await browser.close().catch(() => {});
          }
        } catch (fetchErr) {
          console.log(`  The Stage live fetch error: ${fetchErr.message}`);
        }
      } else if (!tsHtml) {
        const missing = [];
        if (!process.env.BROWSERBASE_API_KEY) missing.push('BROWSERBASE_API_KEY');
        if (!process.env.BROWSERBASE_PROJECT_ID) missing.push('BROWSERBASE_PROJECT_ID');
        if (!stageCookies) missing.push('THESTAGE_COOKIES (no cookies in bundle/env/file)');
        console.log(`  The Stage: no archive, live fetch skipped (missing: ${missing.join(', ')})`);
      }

      // Extract reviews from HTML (archive or live-fetched)
      if (tsHtml) {
        const tsReviews = extractStageReviews(tsHtml, show.id);
        console.log(`  The Stage: ${tsReviews.length} reviews extracted`);
        for (const r of tsReviews) {
          results.push({
            showId: show.id,
            outletId: resolveArchiveRowOutletId({ url: r.url, outletLabel: r.outlet, cachedOutletId: r.outletId, sourceOutletId: 'thestage' }),
            outlet: r.outlet || 'Unknown',
            criticName: r.critic || 'Unknown',
            url: r.url || '',
            excerpt: r.excerpt || '',
            score: r.stars ? Math.round((r.stars / 5) * 100) : null,
            scoreSource: r.stars ? 'thestage-roundup-star-rating' : undefined,
            source: 'thestage-roundup',
          });
        }
      }
    } catch (err) {
      console.log(`  The Stage error: ${err.message}`);
    }
  }

  console.log(`  [Layer 1 Total] ${results.length} reviews from aggregators`);
  // Return discovered aggregator URLs via non-enumerable property so existing
  // call sites using spread (`...aggResults`) continue to work unchanged.
  Object.defineProperty(results, '_aggregatorUrls', {
    value: { bwwRoundupUrl: BWW_ROUNDUP_URL || null },
    enumerable: false,
  });
  return results;
}

/**
 * Run Layer 2: RSS Feeds
 * @param {string} showTitle
 * @param {Set} knownUrls
 * @param {string} [openingDate] - Show's opening date (YYYY-MM-DD). Enables date-window
 *   filtering on narrow theater feeds instead of title matching.
 */
async function runRSSFeeds(showTitle, knownUrls, openingDate = null, market = 'broadway') {
  console.log('\n[Layer 2] RSS Feeds...');
  try {
    const results = await checkRSSFeeds(showTitle, {
      maxHoursAgo: 72,
      knownUrls,
      verbose: true,
      openingDate,
      market,
    });
    console.log(`  [Layer 2 Total] ${results.length} reviews from RSS`);
    return results;
  } catch (err) {
    console.log(`  RSS error: ${err.message}`);
    return [];
  }
}

/**
 * Run Layer 3: Direct Site Search
 * @param {string} showTitle
 * @param {string[]} missingOutletIds
 * @param {Set} knownUrls
 * @param {string} [market]
 * @param {string} [openingDate] - Show's opening date. Passed to date-aware endpoints (e.g. TheaterMania).
 * @param {Object} [show] - Full show object; passed to applies() predicates (e.g. opera-only outlets).
 */
async function runSiteSearch(showTitle, missingOutletIds, knownUrls, market = 'broadway', openingDate = null, show = null) {
  console.log('\n[Layer 3] Site Search...');

  // Only search outlets that have site-search configs AND are missing
  const searchable = missingOutletIds.filter(id => SITE_SEARCH_ENDPOINTS[id]);
  if (searchable.length === 0) {
    console.log('  No searchable outlets missing');
    return [];
  }

  console.log(`  Searching ${searchable.length} outlets: ${searchable.join(', ')}`);

  try {
    const results = await searchOutletSites(showTitle, searchable, {
      knownUrls,
      verbose: true,
      skipJs: !process.env.SCRAPINGBEE_API_KEY, // Skip JS-rendered if no API key
      market,
      openingDate,
      show,
    });
    console.log(`  [Layer 3 Total] ${results.length} reviews from site search`);
    return results;
  } catch (err) {
    console.log(`  Site search error: ${err.message}`);
    return [];
  }
}

// Per-cycle SERP budget. Poller re-runs every iteration (~15 min), so a
// smaller budget still covers missing outlets across ~20 iterations —
// stragglers get picked up on the next cycle instead of in one expensive pass.
const SERP_BUDGET = 12;

/**
 * Gate BrightData away from OB/OWE. Their reviews trickle over weeks so a
 * 1-2h SERP discovery delay is invisible, and SB alone is enough. Cuts BD
 * spend without affecting opening-night quality on BW/WE.
 *
 * Exclusion (not inclusion) is deliberate: shows sometimes ship with null
 * category on opening day (Schmigadoon incident), and the conservative
 * default is to keep BD available — better to overspend a couple dollars
 * than silently drop opening-night SERP quality for a misclassified show.
 *
 * @param {{ category?: string, market?: string }} show
 * @returns {boolean} true when BD should be used for this show
 */
function isBrightDataAllowedForShow(show) {
  const showCategory = (show && (show.category || show.market)) || '';
  return showCategory !== 'off-broadway' && showCategory !== 'off-west-end';
}

/**
 * Run Layer 4: SERP Backup
 */
async function runSERPBackup(show, missingOutlets, knownUrls) {
  console.log('\n[Layer 4] SERP Backup...');

  if (!process.env.SCRAPINGBEE_API_KEY && !process.env.BRIGHTDATA_TOKEN) {
    console.log('  Skipped: no SERP API keys');
    return [];
  }

  const results = [];
  let calls = 0;
  const bdAllowedForShow = isBrightDataAllowedForShow(show);

  for (const outlet of missingOutlets) {
    if (calls >= SERP_BUDGET) {
      console.log(`  SERP budget exhausted (${SERP_BUDGET} calls)`);
      break;
    }
    if (!outlet.domain) continue;

    try {
      process.stdout.write(`  ${outlet.name}... `);
      calls++;

      const reviewObj = {
        showId: show.id,
        outletId: outlet.id,
        outlet: outlet.name,
        criticName: 'Unknown',
        url: '',
      };
      // Tight date range for opening night SERP: only reviews from last 14 days
      // Prevents cross-production contamination (e.g., 2022 revival reviews appearing for 2026)
      const DAY = 86400000;
      const openingNightDateRange = {
        dateMin: new Date(Date.now() - 14 * DAY),
        dateMax: new Date(Date.now() + 7 * DAY),
      };

      // NOTE: No lifecycle SERP gate here — this is a FRESH per-outlet
      // discovery during opening night polling, not a retry of an existing
      // review file. reviewObj has no incompleteReason/serpRetryCount/
      // serpRetryAfter so shouldRetryUrlDiscovery would return not_gated
      // regardless. The tight date range (±14d/7d) and showCoverageBudget
      // in the caller are the cost controls here.
      const result = await discoverCorrectUrl(
        reviewObj,
        process.env.SCRAPINGBEE_API_KEY || '',
        {
          brightDataKey: bdAllowedForShow ? (process.env.BRIGHTDATA_TOKEN || '') : '',
          preferSpeed: false, // BD-first: SERP only runs after 3h gate so latency no longer critical
          // A Scrapingdog SERP success with 0 results here often means "review
          // hasn't published yet," not a genuine zero — must keep falling
          // through to BD/SB rather than caching/accepting it as final
          // (task #213; see shouldAcceptEmptyScrapingdogSerp).
          emptyAuthoritative: false,
          dateRange: openingNightDateRange,
        }
      );

      const url = (result && result !== '__SERP_UNAVAILABLE__') ? result : null;
      if (url && !knownUrls.has(url)) {
        console.log('found');
        results.push({
          showId: show.id,
          outletId: outlet.id,
          outlet: outlet.name,
          criticName: 'Unknown',
          url,
          source: 'serp-discovery',
        });
      } else {
        console.log(url ? 'already known' : 'not found');
      }
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
  }

  console.log(`  [Layer 4 Total] ${results.length} reviews from SERP (${calls} calls)`);
  return results;
}

/**
 * Create review files for newly discovered reviews.
 * Handles dedup against existing files.
 */
function processDiscoveredReviews(showId, reviews, knownUrls, options = {}) {
  const { allowOffBroadway = false, allowWestEnd = false, allowOpera = false } = options;
  let created = 0;
  let skipped = 0;
  let rejected = 0;

  for (const review of reviews) {
    // Skip if URL already known
    if (review.url && knownUrls.has(review.url)) {
      skipped++;
      continue;
    }

    // Skip BWW excerpt-only reviews (no URL) — they need special handling
    if (!review.url && review.bwwExcerpt) {
      continue; // BWW excerpt merge is handled by gatherReviewsForShow
    }

    if (!review.url) {
      skipped++;
      continue;
    }

    // Skip creating --unknown files when a named-critic file already exists for this outlet
    // (Titanique postmortem: amny--unknown.json, chicagotribune--unknown.json alongside named files)
    const criticName = review.criticName || '';
    const isUnknownCritic = !criticName || criticName.toLowerCase() === 'unknown';
    if (isUnknownCritic && review.outletId) {
      const showDir = path.join(REVIEW_TEXTS_DIR, showId);
      if (fs.existsSync(showDir)) {
        // outletId from the pipeline is already a canonical slug (e.g., "nyt-theater",
        // "new-york-times"). Use it directly — don't strip hyphens or we miss collisions.
        const outletSlug = normalizeOutlet(review.outletId);
        const namedFiles = fs.readdirSync(showDir).filter(f =>
          f.startsWith(outletSlug + '--') && !f.includes('--unknown') && f.endsWith('.json')
        );
        // Balusters postmortem CLASS 2 — allow multi-critic-per-outlet.
        // Only skip if the incoming URL matches an existing file's URL. Different URL =
        // almost certainly a different critic (Theatrely/andrew-martini interview on disk
        // shouldn't block Theatrely/joey-sims review at a distinct URL).
        // Ship-check P1 #6: use canonical normalizeUrl (handles http/https, www., query
        // tracking params, fragments). A UTM-tagged variant of the same URL should dedup.
        const incomingUrl = normalizeUrlCanonical(review.url || '');
        const hasExactUrlMatch = namedFiles.some(f => {
          try {
            const rec = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
            const existingUrl = normalizeUrlCanonical(rec.url || '');
            return existingUrl && incomingUrl && existingUrl === incomingUrl;
          } catch { return false; }
        });
        if (hasExactUrlMatch) {
          console.log(`  [SKIP] ${outletSlug}--unknown: named-critic file with same URL already exists`);
          skipped++;
          continue;
        }
        if (namedFiles.length > 0) {
          console.log(`  [ALLOW] ${outletSlug}--unknown: ${namedFiles.length} existing named file(s) for outlet but URL is distinct — treating as new critic`);
        }
      }
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would create: ${review.outletId || review.outlet} — ${review.url}`);
      created++;
      continue;
    }

    const result = createReviewFile(showId, review, { allowOffBroadway, allowWestEnd, allowOpera, fromPostOpening: true });
    if (result === true) {
      created++;
      knownUrls.add(review.url);
    } else if (typeof result === 'string') {
      rejected++;
    } else {
      skipped++; // Already exists
    }
  }

  return { created, skipped, rejected };
}

/**
 * Main poll cycle
 */
async function pollCycle() {
  if (!SHOW_ID) {
    console.error('Usage: node scripts/opening-night-poller.js --show=SHOW_ID');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     Opening Night Review Poller              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Show: ${SHOW_ID}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  // Load show data
  const show = loadShowData(SHOW_ID);
  if (!show) {
    console.error(`Show not found: ${SHOW_ID}`);
    process.exit(1);
  }

  const market = isLondonMarket(show.category) ? 'west-end' : 'broadway';
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);
  console.log(`Title: ${show.title}`);
  console.log(`Market: ${market}`);

  // Balusters postmortem CLASS 7 — backoff guard. Skip cycle if still in cooldown,
  // unless we're in the first 6h after opening (aggressive window always runs).
  // FORCE_SERP also bypasses the gate for manual dispatches that explicitly want to retry.
  const backoff = loadBackoffState(SHOW_ID);
  if (!FORCE_SERP && !isInAggressiveWindow(show) && backoff.nextRunAfter && Date.now() < backoff.nextRunAfter) {
    const waitMinutes = Math.ceil((backoff.nextRunAfter - Date.now()) / 60000);
    console.log(`\n[BACKOFF] Skipping poll — ${backoff.consecutiveNoOp} consecutive no-op runs; next run in ${waitMinutes}m. Pass --force-serp to bypass.`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `backoff_skipped=true\nbackoff_wait_minutes=${waitMinutes}\n`);
    }
    process.exit(0);
  }

  // Pre-wipe: mark preview-period stubs as placeholders before discovery runs.
  // Any unscored file modified >2h before opening is almost certainly contamination
  // (preview-period SERP/aggregator). Marking them lets mergeReviews replace wholesale.
  if (show.openingDate) {
    const wiped = preWipePreOpeningFiles(SHOW_ID, show.openingDate);
    if (wiped > 0) console.log(`  Pre-wipe: ${wiped} preview-period files marked as placeholders`);
  }

  // Pre-poll state
  const knownUrls = getKnownUrls(SHOW_ID, { show, market });
  const preStatus = checkReadiness(SHOW_ID, market);
  console.log(`\nPre-poll: ${preStatus.total} scored reviews (T1:${preStatus.t1} T2:${preStatus.t2} hi-conf:${preStatus.highConfidence})`);
  if (preStatus.ready) {
    console.log('Show is ALREADY broadcast-ready!');
  }

  // ── Layers 1+2+3: Parallel Discovery ──
  // Aggregators, RSS, and SSR site-search run simultaneously.
  // JS-rendered site-search (ScrapingBee cost) runs after, with missing-outlet filter,
  // to avoid burning SB credits on outlets already found by aggregators/RSS.
  if (SKIP_SITE_SEARCH) console.log('\n[Layer 3] Site Search... SKIPPED (--skip-site-search)');

  // SSR outlets are free (plain HTTP) — run unconditionally in parallel.
  // JS-rendered outlets cost SB credits — run only for still-missing outlets after parallel phase.
  // applies() gate: opera outlets only fire when show.type === 'opera'. Without this,
  // bachtrack/parterre/operawire/nycr/cva would fire on every Broadway show, burning
  // ~5 extra HTTP calls per poll cycle across 700+ Broadway shows.
  const ssrSiteSearchIds = !SKIP_SITE_SEARCH
    ? Object.keys(SITE_SEARCH_ENDPOINTS).filter(id => {
        const ep = SITE_SEARCH_ENDPOINTS[id];
        return !ep.requiresJs
          && (!ep.market || ep.market === market)
          && (!ep.applies || ep.applies(show));
      })
    : [];

  const [aggSettled, rssSettled, ssrSettled] = await Promise.allSettled([
    runAggregators(show),
    runRSSFeeds(show.title, knownUrls, show.openingDate || null, market),
    ssrSiteSearchIds.length > 0
      ? runSiteSearch(show.title, ssrSiteSearchIds, knownUrls, market, show.openingDate || null, show)
      : Promise.resolve([]),
  ]);
  const aggResults = aggSettled.status === 'fulfilled' ? aggSettled.value : (console.log(`  [Layer 1] ERROR: ${aggSettled.reason?.message}`), []);
  const rssResults = rssSettled.status === 'fulfilled' ? rssSettled.value : (console.log(`  [Layer 2] ERROR: ${rssSettled.reason?.message}`), []);
  const ssrSiteSearchResults = ssrSettled.status === 'fulfilled' ? ssrSettled.value : (console.log(`  [Layer 3 SSR] ERROR: ${ssrSettled.reason?.message}`), []);

  // JS-rendered site-search: only for outlets still missing after parallel phase.
  // Prevents burning SB credits on outlets aggregators/RSS already found.
  let jsSiteSearchResults = [];
  if (!SKIP_SITE_SEARCH) {
    const foundAfterParallel = getFoundOutletIds(SHOW_ID, { show, market });
    for (const r of [...aggResults, ...rssResults, ...ssrSiteSearchResults]) {
      if (r.outletId) foundAfterParallel.add(r.outletId.toLowerCase());
    }
    const missingJsIds = Object.keys(SITE_SEARCH_ENDPOINTS).filter(id => {
      const ep = SITE_SEARCH_ENDPOINTS[id];
      return ep.requiresJs
        && (!ep.market || ep.market === market)
        && (!ep.applies || ep.applies(show))
        && !foundAfterParallel.has(id.toLowerCase());
    });
    if (missingJsIds.length > 0) {
      jsSiteSearchResults = await runSiteSearch(show.title, missingJsIds, knownUrls, market, show.openingDate || null, show);
    }
  }

  const siteSearchResults = [...ssrSiteSearchResults, ...jsSiteSearchResults];

  // ── Layer 4: SERP — gated by (a) 3h since opening AND (b) market+time cadence ──
  // (a) SERP indexes major outlets ~3h after publication (measured: Giant/Proof opening nights).
  //     Skip entirely until 3h after openingDate — calls before then return nothing.
  // (b) Beyond the 3h gate, market/time cadence (pollMode + shouldRunSerpForMode) decides.
  //     Aggressive window (BW 0-14h, WE 12-30h): run every cron fire.
  //     Outside aggressive: gate to morning-cron slot, with day-cadence thinning further
  //     for older shows (days 15-60 every 3d, 61-90 weekly, 90+ skip).
  //     Keeps layers 1-3 (aggregators/RSS/SSR) running; only expensive SERP is thinned.
  const SERP_MIN_HOURS_AFTER_OPENING = 3;
  const _mode = pollMode(show);
  console.log(`  Poll mode: ${_mode}`);

  function shouldRunSerp() {
    if (!show.openingDate) return true; // No opening date — can't gate, run normally
    const hoursSinceOpening = (Date.now() - new Date(show.openingDate).getTime()) / 3600000;
    if (hoursSinceOpening < SERP_MIN_HOURS_AFTER_OPENING) {
      console.log(`\n[Layer 4] SERP Backup... SKIPPED (${hoursSinceOpening.toFixed(1)}h since opening, gate is ${SERP_MIN_HOURS_AFTER_OPENING}h)`);
      return false;
    }
    if (!FORCE_SERP && !shouldRunSerpForMode(_mode, show)) {
      const cronHour = new Date().getUTCHours();
      console.log(`\n[Layer 4] SERP Backup... SKIPPED (mode=${_mode}, UTC hour=${cronHour} — not a SERP slot for this cadence; pass --force-serp to bypass)`);
      return false;
    }
    if (FORCE_SERP && !shouldRunSerpForMode(_mode, show)) {
      console.log(`  --force-serp: bypassing cadence gate (mode=${_mode})`);
    }
    return true;
  }

  // WE opening-night SERP burst (ON by default, hard-capped). Corrected diagnosis
  // (data/audit/we-serp-diagnosis-corrected.md): the orchestrator forces --skip-serp on
  // iterations 1-8, and those runs are usually cancelled before the deferred SERP (iter
  // 9-10) ever runs — so aggressive-window WE shows get no SERP at all. We override
  // --skip-serp for those shows, bounded by the daily-global + per-show ceilings in
  // scripts/lib/serp-burst-caps.js (the per-cycle SERP_BUDGET still bounds outlet fan-out).
  // Disabled only via the DISABLE_WE_SERP_BURST kill-switch.
  let serpBurstActive = false;
  if (SKIP_SERP && ENABLE_WE_SERP_BURST) {
    const hoursSinceOpening = show.openingDate
      ? (Date.now() - new Date(show.openingDate).getTime()) / 3600000
      : null;
    const ledger = loadSerpBurstLedger();
    const decision = checkSerpBurstAllowed({
      flagEnabled: true,
      show,
      mode: _mode,
      hoursSinceOpening,
      burstsToday: ledger.globalBursts,
      burstsForShowToday: ledger.perShow[SHOW_ID] || 0,
    });
    if (decision.allowed) {
      serpBurstActive = true;
      console.log(
        `\n[Layer 4] SERP BURST: overriding --skip-serp for aggressive-window WE show ` +
        `(${ledger.perShow[SHOW_ID] || 0}/${DEFAULT_SERP_BURST_CONFIG.perShowCap} this show, ` +
        `${ledger.globalBursts}/${DEFAULT_SERP_BURST_CONFIG.dailyGlobalCap} used today)`
      );
    } else {
      console.log(`\n[Layer 4] SERP burst not allowed (${decision.reason}) — honoring --skip-serp`);
    }
  }

  let serpResults = [];
  if ((!SKIP_SERP && shouldRunSerp()) || serpBurstActive) {
    const foundOutletIds = getFoundOutletIds(SHOW_ID, { show, market });
    for (const r of [...aggResults, ...rssResults, ...siteSearchResults]) {
      if (r.outletId) foundOutletIds.add(r.outletId.toLowerCase());
    }
    // Sort T1 before T2 so the 30-call SERP budget goes to highest-value outlets first
    let missingOutlets = getMissingT1T2Outlets(SHOW_ID, market, show)
      .filter(o => !foundOutletIds.has(o.id.toLowerCase()))
      .sort((a, b) => (a.tier || 3) - (b.tier || 3));
    // For WE shows on day 1+: also search notable T3 WE outlets
    // Skip first 24h (opening night) — T3 outlets haven't published yet and SERP adds ~90s
    const daysSinceOpening = show.openingDate
      ? (Date.now() - new Date(show.openingDate).getTime()) / 86400000
      : 999;

    // Broadway T3 SERP: ~12 historically high-activity Broadway T3 outlets
    // Curated by 2024-26 review count (covers ~85% of T3 volume vs 800+ total).
    // One Minute Critic added after Proof opening-night miss (2026-04-17).
    // Same 3h SERP gate as T1/T2 — Broadway T3 outlets DO publish opening night.
    // Cost: T3 sorted last, capped by 30/cycle budget. Once found, getFoundOutletIds
    // excludes them next cycle → natural decay.
    if (market === 'broadway') {
      const BROADWAY_T3_SERP_OUTLETS = [
        'theater-scene', 'theater-life', 'culturesauce', 'front-row-center',
        'pages-on-stages', 'one-minute-critic', 'theatre-reviews-limited',
        'cititour', 'digital-journal', 'stageandcinema', 'frontmezzjunkies',
        'exeunt-magazine', 'cote-notices',
      ];
      const reg = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
      const allOutlets = reg.outlets || reg;
      let added = 0;
      for (const t3Id of BROADWAY_T3_SERP_OUTLETS) {
        if (foundOutletIds.has(t3Id.toLowerCase())) continue;
        const outlet = allOutlets[t3Id];
        if (outlet) {
          missingOutlets.push({ id: t3Id, name: outlet.displayName || t3Id, tier: outlet.tier || 3, domain: outlet.domain });
          added++;
        }
      }
      if (added > 0) console.log(`  [Broadway T3 SERP: queued ${added} high-activity outlets]`);
      missingOutlets.sort((a, b) => (a.tier || 3) - (b.tier || 3));
    }

    if (isLondonMarket(market) && daysSinceOpening < 1) {
      console.log(`  [T3 SERP skipped: opening night (${daysSinceOpening.toFixed(1)} days). T3 outlets added after 24h]`);
    }
    if (isLondonMarket(market) && daysSinceOpening >= 1) {
      // Notable T3 WE outlets that regularly review shows and have searchable domains
      // ~18 outlets × 5s each = ~90s extra SERP time per show, acceptable for day 2+ polls
      const WE_T3_SERP_OUTLETS = [
        'new-statesman', 'afridiziak-theatre-news', 'theatreandtonic',
        'west-end-best-friend', 'all-that-dazzles-uk',
        'london-box-office', 'artsdesk', 'theatre-weekly', 'theupcoming',
        'musical-theatre-review', 'british-theatre', 'everything-theatre',
        'londonist', 'thereviewshub', 'city-am', 'a-younger-theatre',
        'west-end-wilma', 'digital-spy', 'monstagigz',
        'radio-times', 'attitude', 'metro-uk', 'lost-in-theatreland',
        'the-spectator-uk', 'shy-strange-manic',
      ];
      const reg = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
      const allOutlets = reg.outlets || reg;
      for (const t3Id of WE_T3_SERP_OUTLETS) {
        if (foundOutletIds.has(t3Id.toLowerCase())) continue;
        const outlet = allOutlets[t3Id];
        if (outlet) {
          missingOutlets.push({ id: t3Id, name: outlet.displayName || t3Id, tier: outlet.tier, domain: outlet.domain });
        }
      }
      // Sort: UK T1/T2 first, then UK T3, then dual-market US
      const ukOutlets = missingOutlets.filter(o => {
        const outlet = allOutlets[o.id];
        return outlet && (outlet.region === 'london' || outlet.region === 'uk');
      });
      const rest = missingOutlets.filter(o => !ukOutlets.find(u => u.id === o.id));
      missingOutlets = [...ukOutlets, ...rest];
    }
    if (missingOutlets.length > 0) {
      // Daily SERP-SESSION cap (Sprint 1, scripts/lib/serp-session-cap.js). A hard per-show +
      // daily-global ceiling on SERP-running cycles, consulted for ALL SERP runs (burst or
      // normal) right before the network fan-out. Strict no-op at today's ~2 cycles/opening
      // (perShowCap 30, dailyGlobalCap 60); the real safety net once the Sprint-2 orchestrator
      // deferral removal makes the poller the sole owner of "when to run SERP". Increment only
      // when SERP actually runs (missing outlets exist AND not capped), so a capped or no-op
      // cycle never consumes the budget and starves another opening.
      const sessionLedger = loadSerpSessionLedger();
      const sessionDecision = checkSerpSessionAllowed({
        perShowToday: sessionLedger.perShow[SHOW_ID] || 0,
        globalToday: sessionLedger.globalSessions,
      });
      if (!sessionDecision.allowed) {
        console.log(
          `\n[Layer 4] SERP Backup... SKIPPED (daily SERP-session cap reached: ` +
          `${sessionDecision.reason} ${sessionDecision.used}/${sessionDecision.limit})`
        );
        // Leave serpResults = [] and fall through; layers 1-3 results still process below.
      } else {
      incrementSerpSessionLedger(SHOW_ID);
      console.log(
        `  [SERP session ${(sessionLedger.perShow[SHOW_ID] || 0) + 1}/${DEFAULT_SERP_SESSION_CONFIG.perShowCap} this show, ` +
        `${sessionLedger.globalSessions + 1}/${DEFAULT_SERP_SESSION_CONFIG.dailyGlobalCap} today]`
      );
      // Count the burst against the daily ledger only when SERP actually runs (missing
      // outlets exist) — a no-op cycle where everything is already found must not consume
      // the daily/per-show cap and starve another opening.
      if (serpBurstActive) {
        const updated = incrementSerpBurstLedger(SHOW_ID);
        // Automated tripwire: if daily bursts get unusually high, fire ONE real owner email
        // (sendAlert) per UTC day — no human log-watching required. The hard daily cap still
        // auto-stops further bursts regardless. tripwireAlerted (persisted in the ledger)
        // dedupes so we don't email every cycle.
        // Direct sendAlert, not routeAlert — this already has its own cooldown:
        // tripwireAlerted resets with the rest of the SERP burst ledger at the
        // next UTC day boundary, giving the same one-per-day dedup the router's
        // ledger would provide.
        if (isCascadeTripwireExceeded(updated.globalBursts) && !updated.tripwireAlerted) {
          updated.tripwireAlerted = true;
          writeSerpBurstLedger(updated);
          const msg =
            `${updated.globalBursts} WE opening-night SERP bursts today ` +
            `(tripwire ${DEFAULT_SERP_BURST_CONFIG.cascadeTripwire}, hard daily cap ${DEFAULT_SERP_BURST_CONFIG.dailyGlobalCap}). ` +
            `Bursts auto-stop at the cap; this is an early heads-up. ` +
            `Emergency off: gh variable set DISABLE_WE_SERP_BURST --body true`;
          console.log(`::warning::SERP burst cascade tripwire: ${msg}`);
          try {
            await sendAlert({
              title: 'WE SERP burst tripwire',
              description: msg,
              // 'error': same-day actionable — the 60-100K credits/day runaway
              // class (feedback_sb_serp_invisible_burn); the daily digest is up
              // to 24h late. warning would be suppressed (actionable-only policy).
              severity: 'error',
              email: true,
            });
          } catch (e) {
            console.log(`  [SERP burst] tripwire alert failed (non-fatal): ${e.message}`);
          }
        }
      }
      serpResults = await runSERPBackup(show, missingOutlets, knownUrls);
      } // end: daily SERP-session cap allowed
    } else {
      console.log('\n[Layer 4] SERP Backup... all T1/T2 outlets found');
    }
  } else if (!SKIP_SERP) {
    // shouldRunSerp() already logged the skip reason
  } else if (!ENABLE_WE_SERP_BURST) {
    console.log('\n[Layer 4] SERP Backup... SKIPPED (--skip-serp)');
  }
  // else: ENABLE_WE_SERP_BURST on but burst disallowed — the "burst not allowed" line above already logged it

  // ── Process discovered reviews ──
  const allDiscovered = [...aggResults, ...rssResults, ...siteSearchResults, ...serpResults];
  console.log(`\n━━━ Processing ${allDiscovered.length} discovered reviews ━━━`);

  const { created, skipped, rejected } = processDiscoveredReviews(
    SHOW_ID,
    allDiscovered,
    knownUrls,
    { allowOffBroadway: isOffBroadway, allowWestEnd: isWestEnd, allowOpera: show.type === 'opera' }
  );

  // ── Aggregator thumb enrichment pass ──
  // When reviews arrive via non-aggregator paths (RSS, SERP, outlet-domain-supplement),
  // dtliThumb / bwwThumb never get populated. This pass re-fetches the aggregator
  // pages and merges thumbs onto already-ingested review files. Best-effort, non-fatal.
  // Card: 34c637c5-416f-8147-b7de-dcc260d0a151
  if (!isWestEnd) {
    try {
      const { enrichDtliThumbsForShow } = require('./enrich-dtli-thumbs');
      console.log('\n[Enrichment] DTLI thumbs...');
      await enrichDtliThumbsForShow(SHOW_ID, { verbose: false });
    } catch (e) {
      console.log(`  [DTLI enrichment] non-fatal: ${e.message}`);
    }
  }
  const bwwUrlFromPoll = (aggResults && aggResults._aggregatorUrls && aggResults._aggregatorUrls.bwwRoundupUrl)
    || BWW_ROUNDUP_URL_CLI
    || show.bwwRoundupUrl
    || null;
  if (!isOffBroadway && bwwUrlFromPoll) {
    try {
      const { enrichBwwThumbsForShow } = require('./enrich-bww-thumbs');
      console.log('\n[Enrichment] BWW RR thumbs...');
      await enrichBwwThumbsForShow(SHOW_ID, { url: bwwUrlFromPoll });
    } catch (e) {
      console.log(`  [BWW enrichment] non-fatal: ${e.message}`);
    }
  }

  // ── Post-poll status ──
  const postStatus = checkReadiness(SHOW_ID, market);
  const newReviews = postStatus.total - preStatus.total;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  POLL CYCLE RESULTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Discovered: ${allDiscovered.length} (agg:${aggResults.length} rss:${rssResults.length} site:${siteSearchResults.length} serp:${serpResults.length}) [parallel: layers 1-3]`);
  console.log(`  Files created: ${created} | Skipped: ${skipped} | Rejected: ${rejected}`);
  console.log(`  Scored reviews: ${preStatus.total} → ${postStatus.total} (+${newReviews})`);
  console.log(`  T1: ${postStatus.t1} | T2: ${postStatus.t2} | Hi-conf: ${postStatus.highConfidence}`);

  if (postStatus.ready) {
    console.log('  Status: BROADCAST READY ✅');
  } else {
    console.log(`  Status: NOT READY — ${postStatus.reasons.join(', ')}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Zero-review alert: warn if show has been open >24h with very few reviews
  if (show.openingDate) {
    const hoursSinceOpening = (Date.now() - new Date(show.openingDate).getTime()) / 3600000;
    if (hoursSinceOpening > 24 && postStatus.total < 3) {
      const msg = `⚠️ LOW COVERAGE: ${show.title} opened ${Math.round(hoursSinceOpening)}h ago but only has ${postStatus.total} scored reviews. Expected 8+ by now.`;
      console.log(`\n${msg}`);
      // Emit as GitHub Actions warning annotation
      if (process.env.GITHUB_ACTIONS) {
        console.log(`::warning::${msg}`);
      }
    }
  }

  // Balusters postmortem CLASS 7 — update backoff state.
  // New reviews reset the counter; no-ops increment and schedule next run.
  try {
    const nextBackoff = {
      consecutiveNoOp: created > 0 ? 0 : (backoff.consecutiveNoOp || 0) + 1,
      lastNewReviewAt: created > 0 ? new Date().toISOString() : backoff.lastNewReviewAt || null,
      lastRunAt: new Date().toISOString(),
      nextRunAfter: 0,
    };
    nextBackoff.nextRunAfter = Date.now() + computeNextBackoffDelayMs(nextBackoff.consecutiveNoOp);
    saveBackoffState(SHOW_ID, nextBackoff);
    if (nextBackoff.consecutiveNoOp > 0) {
      console.log(`  [BACKOFF] ${nextBackoff.consecutiveNoOp} consecutive no-ops — next run after ${new Date(nextBackoff.nextRunAfter).toISOString()}`);
    }
  } catch (e) {
    console.log(`  [BACKOFF] state update failed (non-fatal): ${e.message}`);
  }

  // Balusters postmortem CLASS 4 — Guardian per-show redispatch.
  // If any discovered file is a Guardian URL and the existing guardian review file
  // lacks an originalScore, emit GitHub Actions output so the workflow can dispatch
  // fetch-guardian-reviews.yml for THIS show (normal cron may have already fired).
  let guardianNeedsRedispatch = false;
  try {
    const guardianReviews = allDiscovered.filter(r => (r.outletId || '').toLowerCase() === 'guardian');
    if (guardianReviews.length > 0) {
      // Check on-disk Guardian file to see if originalScore is already set
      const showDir = path.join(REVIEW_TEXTS_DIR, SHOW_ID);
      if (fs.existsSync(showDir)) {
        const guardianFiles = fs.readdirSync(showDir).filter(f => f.startsWith('guardian--'));
        guardianNeedsRedispatch = guardianFiles.some(f => {
          try {
            const rec = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
            return !rec.originalScore && !rec.scoreSource;
          } catch { return false; }
        });
      } else {
        guardianNeedsRedispatch = true; // New discovery, no file yet
      }
      if (guardianNeedsRedispatch) {
        console.log(`  [GUARDIAN] Guardian URL discovered without originalScore — redispatch fetch-guardian-reviews.yml for ${SHOW_ID}`);
      }
    }
  } catch (e) {
    console.log(`  [GUARDIAN] redispatch check failed (non-fatal): ${e.message}`);
  }

  // GitHub Actions outputs
  console.log(`\n::set-output name=ready::${postStatus.ready}`);
  console.log(`::set-output name=new_reviews::${newReviews}`);
  console.log(`::set-output name=total_scored::${postStatus.total}`);
  console.log(`::set-output name=t1_count::${postStatus.t1}`);
  console.log(`::set-output name=t2_count::${postStatus.t2}`);
  console.log(`::set-output name=files_created::${created}`);

  // Also write to GITHUB_OUTPUT if available
  if (process.env.GITHUB_OUTPUT) {
    const outputLines = [
      `ready=${postStatus.ready}`,
      `new_reviews=${newReviews}`,
      `total_scored=${postStatus.total}`,
      `t1_count=${postStatus.t1}`,
      `t2_count=${postStatus.t2}`,
      `files_created=${created}`,
      `guardian_redispatch_needed=${guardianNeedsRedispatch}`,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, outputLines + '\n');
  }
}

if (require.main === module) {
  pollCycle().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { pollCycle, checkReadiness, getMissingT1T2Outlets, getKnownUrls, getFoundOutletIds, isInDiscoveryUnblockWindow, getThresholds, preWipePreOpeningFiles, pollMode, shouldRunSerpForMode, isBrightDataAllowedForShow, SERP_BUDGET, runSERPBackup, loadSerpBurstLedger, incrementSerpBurstLedger, SERP_BURST_LEDGER_PATH, loadSerpSessionLedger, incrementSerpSessionLedger, SERP_SESSION_LEDGER_PATH };
