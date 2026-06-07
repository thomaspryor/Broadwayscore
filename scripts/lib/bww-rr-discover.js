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

const REVIEWS_PAGE_URL = 'https://www.broadwayworld.com/reviews.php';
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
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new Error('BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID required');
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
 * @param {function} [opts.fetchAnchors] - override the reviews.php fetch (testing)
 * @param {function} [opts.fetchSectionAnchors] - override the section fetch (testing)
 * @returns {Promise<{ url: string|null, candidates: Array<{url:string, score:number}>, via: string }>}
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

  // 2. Fall back to reviews.php (Browserbase, ~$0.10/call). Skippable: reviews.php
  //    only lists RECENT roundups, so for a closed/old show the section scan having
  //    found nothing means reviews.php won't either — firing Browserbase there is a
  //    guaranteed-miss cost (the back-catalogue grind would burn ~$0.10 × hundreds
  //    of closed shows). Callers pass skipReviewsPhp:true for closed shows.
  if (opts.skipReviewsPhp) {
    return { url: null, candidates: [], via: 'section-only' };
  }
  const fetchAnchors = opts.fetchAnchors || fetchReviewsPageAnchors;
  try {
    anchors = await fetchAnchors();
  } catch { anchors = []; }
  candidates = score(anchors);
  return { url: candidates[0]?.url || null, candidates, via: 'reviews.php' };
}

module.exports = {
  discoverBwwRoundupUrl,
  fetchReviewsPageAnchors,
  fetchSectionPageAnchors,
  sectionUrlForShow,
  scoreCandidate,
  slugMatchesShow,
  tokensFromTitle,
};
