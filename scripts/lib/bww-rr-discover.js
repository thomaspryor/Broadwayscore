/**
 * BWW Review Roundup URL Discovery
 *
 * Reliable auto-discovery of BWW Review Roundup URLs via broadwayworld.com/reviews.php.
 * Bypasses Cloudflare via Browserbase (per memory/feedback_cloudflare_bypass_hierarchy.md).
 *
 * Why this exists: SERP-based discovery via Google has ~0% same-day success rate —
 * Google's indexer lags BWW publication by 1-6 hours. The 2026-04-15 Fear of 13
 * opening required manual intervention because SERP missed the URL entirely.
 *
 * Strategy: scrape the /reviews.php listing directly. BWW updates this page within
 * minutes of publishing a Review Roundup article. No Google lag, no pattern guessing.
 *
 * Cost: 1 Browserbase session per discovery attempt (~$0.10). Cadence-gated at
 * the caller side — only call within the opening-night window.
 *
 * Used by: scripts/opening-night-poller.js as primary BWW RR discovery path;
 * existing SERP search remains as a final fallback.
 */

const axios = require('axios');
const { fetchLiveBrowserbaseSessionsToday } = require('./browserbase-live-usage');
const { createTtlCache } = require('./ttl-cache');

// Per-run anchor memo (Scraping v2 Sprint 1 T5): the SAME reviews.php / market
// section-page anchor listing was being fetched ~9-11x/run (one node process
// per show, no memo) plus every 5-min watcher tick re-probing an identical
// negative result (#312 audit: ~31 avoidable Browserbase sessions/day from
// watch-aggregator-urls.js alone). 15-min TTL: short enough a freshly
// published roundup surfaces within one poll cycle, long enough to collapse
// the repeat-fetch waste. /tmp/bww-anchors restores via actions/cache@v4 in
// CI, same pattern as scripts/lib/serp-cache.js's /tmp/bd-serp-cache.
const ANCHOR_CACHE_DIR = process.env.BWW_ANCHOR_CACHE_DIR || '/tmp/bww-anchors';
const ANCHOR_CACHE_TTL_MS = Number(process.env.BWW_ANCHOR_CACHE_TTL_MIN || 15) * 60 * 1000;
const _anchorCache = createTtlCache({ dir: ANCHOR_CACHE_DIR, ttlMs: ANCHOR_CACHE_TTL_MS });

/**
 * Memoize an anchor-listing fetch under cacheKey. Only successful results
 * (including a genuine empty array) are cached — a thrown error (missing
 * creds, kill switch, daily cap) propagates uncached so every caller still
 * sees the live failure.
 */
async function _memoizedAnchors(cacheKey, fetchFn) {
  const cached = _anchorCache.get(cacheKey);
  if (cached) return cached;
  const anchors = await fetchFn();
  _anchorCache.set(cacheKey, {}, anchors);
  return anchors;
}

const REVIEWS_PAGE_URL = 'https://www.broadwayworld.com/reviews.php';
// Where reviews.php actually 301s to. Used by the cheap fetchPage tier, whose
// url-verification guard rejects the redirect hop. See
// _fetchReviewsPageAnchorsViaScraperUncached.
const REVIEWS_PAGE_CANONICAL_URL = 'https://www.broadwayworld.com/reviews/';
const BROWSERBASE_API = 'https://api.browserbase.com/v1/sessions';
const NAV_TIMEOUT_MS = 30000;
const SESSION_TIMEOUT_MS = 30000;
// BWW's reviews.php redirects through a Cloudflare "Just a moment..." interstitial.
// `domcontentloaded` fires on the challenge page — we must actively wait for a
// Review-Roundup anchor to appear before reading the DOM. Env-tunable in case
// Cloudflare tightens and we need to raise the wait.
const CF_WAIT_TIMEOUT_MS = parseInt(process.env.BWW_CF_WAIT_MS || '25000', 10);

/**
 * Titlecase-aware comparison: does the BWW URL slug reference this show?
 *
 * BWW slugs are hand-authored marketing copy, e.g.:
 *   Review-Roundup-THE-FEAR-OF-13-Starring-Adrien-Brody-and-Tessa-Thompson-Opens-On-Broadway-20260415
 *   Review-Roundup-TITANIQUE-Sets-Sail-on-Broadway-20260412
 *   Review-Roundup-Critics-Weigh-In-on-THE-BOYS-IN-THE-BAND-on-Broadway-20180531
 *
 * Strategy: normalize both show title and slug, require that every non-stopword
 * token from the show title appears in the slug. Short show titles (1-2 tokens)
 * require ALL tokens matched; longer titles tolerate one missing token.
 */
const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'is']);

// Strip marketing subtitle from a title. "Beaches: A New Musical" → "Beaches".
// "Beaches, A New Musical" → "Beaches". BWW slugs are hand-authored and
// routinely omit subtitles after `:`, `,`, or `—`/`–`/`-`. The canonical
// shows.json entry for Beaches-2026 uses a comma; other shows use colons.
function stripSubtitle(title) {
  if (!title) return '';
  const stripped = title.split(/[:,—–\-]/)[0].trim();
  return stripped || title;
}

function tokensFromTitle(title) {
  return (title || '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t.toLowerCase()));
}

/**
 * Candidate title forms to test against a BWW slug, in priority order:
 *   1. show.shortTitle if set (explicit override in shows.json)
 *   2. subtitle-stripped full title ("Beaches: A New Musical" → "Beaches")
 *   3. full title as-is
 *
 * This exists because BWW authors slugs without subtitles — Beaches opened
 * 2026-04-22 with real URL `Review-Roundup-BEACHES-Opens-on-Broadway-20260422`
 * while the raw-title match required BEACHES+NEW+MUSICAL all be present and
 * silently returned no candidates.
 */
function candidateTitles(show) {
  const out = [];
  if (show.shortTitle) out.push(show.shortTitle);
  const stripped = stripSubtitle(show.title);
  if (stripped && stripped !== show.title) out.push(stripped);
  if (show.title) out.push(show.title);
  return Array.from(new Set(out));
}

function slugMatchesShow(slug, show) {
  const slugUpper = slug.toUpperCase();
  for (const form of candidateTitles(show)) {
    const titleTokens = tokensFromTitle(form);
    if (titleTokens.length === 0) continue;
    const missing = titleTokens.filter(t => !slugUpper.includes(t));
    // All tokens must match for short titles; 1 miss tolerated for 4+ token titles.
    const allowed = titleTokens.length >= 4 ? 1 : 0;
    if (missing.length <= allowed) return true;
  }
  return false;
}

function parseOpeningDateYmd(dateStr) {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

/**
 * Extract the YYYYMMDD suffix at the end of a BWW RR URL.
 * Most URLs end with -YYYYMMDD; a minority omit the date.
 */
function extractUrlDate(url) {
  const m = (url || '').match(/-(\d{8})(?:[\/?#]|$)/);
  return m ? m[1] : null;
}

/**
 * Score a candidate: higher is better. Used to rank when multiple URLs match.
 * Perfect = title tokens all present + date within ±3 days of openingDate.
 */
function scoreCandidate(url, show) {
  let score = 0;
  if (slugMatchesShow(url, show)) score += 10;
  const urlDate = extractUrlDate(url);
  const openYmd = parseOpeningDateYmd(show.openingDate);
  if (urlDate && openYmd) {
    const urlDt = new Date(`${urlDate.slice(0, 4)}-${urlDate.slice(4, 6)}-${urlDate.slice(6, 8)}`).getTime();
    const openDt = new Date(show.openingDate).getTime();
    const daysOff = Math.abs(urlDt - openDt) / 86400000;
    if (daysOff <= 1) score += 5;
    else if (daysOff <= 3) score += 3;
    else if (daysOff <= 7) score += 1;
    else score -= Math.min(5, Math.round(daysOff / 7)); // penalize distant dates
  }
  return score;
}

/**
 * Fetch broadwayworld.com/reviews.php via Browserbase, extract all Review-Roundup
 * anchor hrefs, return as array.
 *
 * Throws if Browserbase credentials are missing or the fetch fails catastrophically.
 * Returns empty array if the page loaded but no Review-Roundup anchors were found.
 */
async function fetchReviewsPageAnchors() {
  return _memoizedAnchors('reviews.php', _fetchReviewsPageAnchorsUncached);
}

/**
 * CHEAP reviews.php anchor scan via the standard scraper chain (~$0.005/call via
 * Bright Data) instead of Browserbase (~$0.10/call — 20x more).
 *
 * Why this exists (2026-07-31 billing audit): reviews.php was reachable ONLY via
 * the paid Browserbase path, which made it look like an expensive Broadway-only
 * luxury and led T4 to gate it off by category. Both halves of that were wrong —
 * see shouldSkipReviewsPhp's docstring for the yield evidence. Routing it through
 * fetchPage() first makes the page cheap enough that no show needs to be excluded
 * for cost reasons, which is what restores the missed Off-Broadway roundups.
 *
 * Plain HTTPS is deliberately NOT used: tested 2026-04-25 (see
 * watch-aggregator-urls.js discoverBwwRoundupFromHomepage) plain fetch works from
 * a residential IP but 403s from GitHub Actions IPs. fetchPage's provider chain
 * handles that transparently.
 *
 * @returns {Promise<string[]|null>} anchors, or null when the cheap tier could not
 *   produce a usable page (caller falls back to the paid Browserbase path).
 */
async function _fetchReviewsPageAnchorsViaScraperUncached() {
  let html = '';
  try {
    const { fetchPage } = require('./scraper');
    // Canonical URL, NOT reviews.php. /reviews.php 301-redirects to /reviews/, and
    // fetchPage's verifyFetchedUrl rejects the result as `url_mismatch` — which is
    // very likely the original reason this page was ever put on Browserbase at all
    // (page.goto follows redirects silently, so the paid path never hit the guard).
    // Measured 2026-07-31: requesting REVIEWS_PAGE_URL through fetchPage fails with
    // "Bright Data returned wrong page (url_mismatch: .../reviews/)"; requesting
    // REVIEWS_PAGE_CANONICAL_URL returns 183KB and 12 Review-Roundup anchors.
    const res = await fetchPage(REVIEWS_PAGE_CANONICAL_URL, { renderJs: false });
    html = (res && res.content) || '';
  } catch {
    return null;
  }
  // BWW soft-404s / Cloudflare interstitials return HTTP 200 with the wrong body
  // (memory: feedback_aggregator_soft_404). Validate we got the real reviews page
  // before trusting "zero anchors" as a genuine answer — otherwise a blocked
  // fetch would masquerade as "no roundups published" and suppress the paid
  // fallback that would have succeeded.
  if (!html || !/broadwayworld/i.test(html)) return null;
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  if (!titleMatch || !/review/i.test(titleMatch[1])) return null;
  const re = /href="(https:\/\/www\.broadwayworld\.com\/article\/[^"]*Review-Roundup[^"]*)"/gi;
  const found = new Set();
  let m;
  while ((m = re.exec(html)) !== null) found.add(m[1]);
  // Relative hrefs (BWW mixes both forms across templates).
  const reRel = /href="(\/article\/Review-Roundup-[^"]+)"/gi;
  while ((m = reRel.exec(html)) !== null) found.add('https://www.broadwayworld.com' + m[1]);
  return [...found];
}

async function fetchReviewsPageAnchorsCheap() {
  return _memoizedAnchors('reviews.php:scraper', _fetchReviewsPageAnchorsViaScraperUncached);
}

async function _fetchReviewsPageAnchorsUncached() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new Error('BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID required');
  }
  if (process.env.BROWSERBASE_KILL_SWITCH === 'true') {
    throw new Error('Browserbase kill switch active (BROWSERBASE_KILL_SWITCH=true)');
  }
  // #312: this path (opening-night-poller.js, watch-aggregator-urls.js,
  // audit-show-review-gap.js) had NO session-count cap at all — only "cadence
  // gated at the caller side" per the module docstring, which in practice
  // meant nothing actually stopped it. Enforce the SAME account-wide daily
  // ceiling collect-review-texts.js uses, checked against the live API so it
  // reflects real total spend regardless of which script is calling.
  const maxPerDay = parseInt(process.env.BROWSERBASE_MAX_SESSIONS_PER_DAY || '250', 10);
  const liveSessionsToday = await fetchLiveBrowserbaseSessionsToday(apiKey, projectId);
  if (liveSessionsToday !== null && liveSessionsToday >= maxPerDay) {
    throw new Error(`Browserbase daily cap reached (${liveSessionsToday}/${maxPerDay}) — BWW RR discovery skipped`);
  }

  let browser = null;
  let sessionId = null;
  try {
    const resp = await axios.post(
      BROWSERBASE_API,
      {
        projectId,
        browserSettings: {
          solveCaptchas: true,
          fingerprint: { locales: ['en-US'], operatingSystems: ['macos'] },
        },
      },
      {
        headers: { 'x-bb-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: SESSION_TIMEOUT_MS,
      }
    );
    sessionId = resp.data.id;

    const { chromium } = require('playwright');
    const connectUrl = `wss://connect.browserbase.com?apiKey=${apiKey}&sessionId=${sessionId}`;
    browser = await chromium.connectOverCDP(connectUrl);
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(REVIEWS_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    // Wait for a Review-Roundup anchor to appear — this naturally handles the
    // Cloudflare challenge (selector can't match until the challenge clears and
    // the real reviews.php renders). Timeout returns null; we then return [] so
    // the caller falls through to URL-guessing. Using `waitForSelector` (over
    // `waitForFunction`) keeps the CF-wait concern decoupled from the content
    // semantics — a genuinely empty reviews.php page would also time out, which
    // is the right behavior (no anchors means no discovery, regardless of CF).
    const anchorFound = await page.waitForSelector(
      'a[href*="Review-Roundup"]',
      { timeout: CF_WAIT_TIMEOUT_MS }
    ).catch(() => null);
    if (!anchorFound) {
      // ::warning:: matches the surfacing style at opening-night-poller.js:476
      console.log(`::warning::bww-rr-discover: reviews.php selector did not match within ${CF_WAIT_TIMEOUT_MS}ms (Cloudflare challenge likely still active or page empty)`);
      return [];
    }
    const hrefs = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href*="Review-Roundup"]'));
      const set = new Set();
      anchors.forEach(a => {
        const href = a.href;
        if (href && href.includes('/article/Review-Roundup')) set.add(href);
      });
      return Array.from(set);
    });
    return hrefs;
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

/**
 * Default policy for whether to skip the paid reviews.php (Browserbase) path.
 * Fail-open: only an AFFIRMATIVE off-Broadway category skips it. Null/missing/
 * unknown category always probes — a misclassified Broadway show must never
 * lose its fast (and free, non-Browserbase) discovery path.
 *
 * SCOPE (corrected 2026-07-31): this gates ONLY the paid Browserbase fallback.
 * The cheap fetchPage() reviews.php scan runs for every show regardless.
 *
 * The original T4 rationale — "reviews.php only ever lists Broadway roundups
 * (#312 audit: 0/12 sampled Off-Broadway polls resolved a URL there)" — is
 * empirically FALSE and was a yield regression. Measured against a live
 * reviews.php fetch on 2026-07-31, three in-window OFF-Broadway shows had
 * score-15 Review-Roundup matches sitting on that page while T4 skipped them:
 *   the-saviors-off-broadway-2026            -> Review-Roundup-THE-SAVIORS-...
 *   cat-cohen-broad-strokes-off-broadway-2026 -> Review-Roundup-Cat-Cohens-BROAD-STROKES-...
 *   les-miserables-arena-...-off-broadway-2026 -> Review-Roundup-LES-MISERABLES-THE-ARENA-...
 * (An off-west-end show, midnight-at-the-never-get, also matched.) The #312
 * sample almost certainly measured the Browserbase path failing the Cloudflare
 * wait, not reviews.php lacking OB content.
 *
 * So category is NOT a proxy for "reviews.php can't help this show". It is only
 * a weak cost heuristic for whether a $0.10 session is worth spending when the
 * cheap tier has already come back empty.
 *
 * @param {object} show - shows.json record; reads show.category
 * @returns {boolean}
 */
function shouldSkipReviewsPhp(show) {
  const category = String((show && show.category) || '').toLowerCase();
  return category === 'off-broadway';
}

/**
 * Map a show to its BWW section listing page. BWW section pages carry a "Latest
 * Reviews" widget that links Review-Roundup articles within minutes of publish —
 * cheaper and more reliable than Google SERP, and (unlike reviews.php) reachable
 * without Browserbase. Verified 2026-06-06: /off-broadway/ listed both the
 * A Woman Among Women and Girl, Interrupted roundups; the main homepage did not.
 */
function sectionUrlForShow(show) {
  const cat = String(show && show.category || '').toLowerCase();
  if (cat === 'off-broadway') return 'https://www.broadwayworld.com/off-broadway/';
  if (cat === 'west-end' || cat === 'off-west-end') return 'https://www.broadwayworld.com/westend/';
  return 'https://www.broadwayworld.com/'; // broadway / default (homepage)
}

/**
 * Cheap section-page anchor scan via the standard scraper chain. Prefers
 * ScrapingBee (proven reliable for broadwayworld section pages; Bright Data has
 * shown intermittent empty-200s and Playwright times out on BWW's CF interstitial).
 * Returns [] on any failure so the caller falls through to the Browserbase path.
 */
async function fetchSectionPageAnchors(show) {
  const url = sectionUrlForShow(show);
  return _memoizedAnchors(url, () => _fetchSectionPageAnchorsUncached(url));
}

async function _fetchSectionPageAnchorsUncached(url) {
  let html = '';
  try {
    const { fetchWithScrapingBee } = require('./scraper');
    const r = await fetchWithScrapingBee(url, { renderJs: false });
    html = (r && (r.content || r.html || r.body)) || '';
  } catch { /* fall through to fetchPage */ }
  if (!html || html.length < 5000) {
    try {
      const { fetchPage } = require('./scraper');
      const r = await fetchPage(url, { timeout: 60000 });
      html = (typeof r === 'string') ? r : ((r && (r.content || r.html || r.body)) || '');
    } catch { /* leave html empty */ }
  }
  const { extractRoundupAnchors } = require('./bww-homepage-scan');
  return extractRoundupAnchors(html);
}

/**
 * Primary entry point: find the BWW RR URL for a given show.
 *
 * Discovery order (cheapest + most reliable first):
 *   1. Market section-page scan (ScrapingBee, no Browserbase, no Google lag).
 *      This is the path that makes OFF-Broadway work consistently — its roundups
 *      live on /off-broadway/, which SERP ranked poorly and the poller used to
 *      skip entirely (girl-interrupted / a-woman-among-women 2026-06).
 *   2. reviews.php via Browserbase (Cloudflare-gated; the proven Broadway path).
 *
 * @param {object} show - shows.json record; needs { title, openingDate, category }
 * @param {object} [opts]
 * @param {function} [opts.fetchAnchors] - override the PAID reviews.php fetch
 *   (testing). When supplied, the cheap tier is bypassed entirely so existing
 *   tests exercise the paid path deterministically.
 * @param {function} [opts.fetchCheapAnchors] - override the cheap reviews.php fetch (testing)
 * @param {function} [opts.fetchSectionAnchors] - override the section fetch (testing)
 * @param {boolean} [opts.skipReviewsPhp] - caller's OWN cost guard for the paid
 *   tier. OR'd with shouldSkipReviewsPhp(show); an explicit `false` does NOT
 *   disable the category default.
 * @returns {Promise<{ url: string|null, candidates: Array<{url:string, score:number}>, via: string }>}
 *   via: 'section' | 'reviews.php-cheap' | 'section-only' | 'reviews.php'
 *      | 'cap-exhausted' | 'provider-error' | 'not-found'
 */
async function discoverBwwRoundupUrl(show, opts = {}) {
  const score = (anchors) => anchors
    .map(url => ({ url, score: scoreCandidate(url, show) }))
    .filter(c => c.score >= 10)              // must at least match title tokens
    .sort((a, b) => b.score - a.score);

  // 1. Cheap section-page scan first.
  let anchors = [];
  try {
    const fetchSection = opts.fetchSectionAnchors || fetchSectionPageAnchors;
    anchors = await fetchSection(show);
  } catch { anchors = []; }
  let candidates = score(anchors);
  if (candidates.length > 0) {
    return { url: candidates[0].url, candidates, via: 'section' };
  }

  // 2. CHEAP reviews.php scan via fetchPage (~$0.005). Runs for EVERY show — no
  //    category or closed-show gate. This is the step that recovers the
  //    Off-Broadway roundups T4 was skipping (see shouldSkipReviewsPhp docstring
  //    for the three measured live misses). Only if this comes back empty or
  //    unusable do we consider spending a $0.10 Browserbase session.
  if (!opts.fetchAnchors) {
    let cheapAnchors = null;
    try {
      const fetchCheap = opts.fetchCheapAnchors || fetchReviewsPageAnchorsCheap;
      cheapAnchors = await fetchCheap();
    } catch { cheapAnchors = null; }
    if (cheapAnchors && cheapAnchors.length > 0) {
      const cheapCandidates = score(cheapAnchors);
      if (cheapCandidates.length > 0) {
        return { url: cheapCandidates[0].url, candidates: cheapCandidates, via: 'reviews.php-cheap' };
      }
    }
  }

  // 3. Paid Browserbase reviews.php fallback (~$0.10/call). THIS is what the skip
  //    gate protects — not discovery itself. Skippable for closed shows (reviews.php
  //    lists only RECENT roundups, so the back-catalogue grind would burn ~$0.10 x
  //    hundreds of closed shows) and, by category default, where a paid retry after
  //    an empty cheap scan is judged not worth it. Callers pass skipReviewsPhp
  //    explicitly to override the shouldSkipReviewsPhp(show) default.
  //
  //    Composition note: an explicit `false` from a caller means "don't apply MY
  //    guard", not "override the category default" — the two guards are OR'd, so a
  //    call site like { skipReviewsPhp: show.status === 'closed' } can no longer
  //    silently disable the category default for every open show (the bug that made
  //    the hourly audit-aggregator-gap run bypass T4 entirely).
  const explicitSkip = opts.skipReviewsPhp === true;
  const skipReviewsPhp = explicitSkip || shouldSkipReviewsPhp(show);
  if (skipReviewsPhp) {
    return { url: null, candidates: [], via: 'section-only' };
  }
  const fetchAnchors = opts.fetchAnchors || fetchReviewsPageAnchors;
  try {
    anchors = await fetchAnchors();
  } catch (err) {
    const msg = String((err && err.message) || '');
    const via = /cap reached/i.test(msg) ? 'cap-exhausted' : 'provider-error';
    return { url: null, candidates: [], via };
  }
  candidates = score(anchors);
  if (candidates.length === 0) {
    return { url: null, candidates: [], via: 'not-found' };
  }
  return { url: candidates[0].url, candidates, via: 'reviews.php' };
}

module.exports = {
  discoverBwwRoundupUrl,
  fetchReviewsPageAnchors,
  fetchReviewsPageAnchorsCheap,
  fetchSectionPageAnchors,
  sectionUrlForShow,
  scoreCandidate,
  slugMatchesShow,
  tokensFromTitle,
  shouldSkipReviewsPhp,
};
