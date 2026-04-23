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
// BWW slugs are hand-authored and routinely omit subtitles after `:` or `—`.
function stripSubtitle(title) {
  if (!title) return '';
  const stripped = title.split(/[:—–\-]/)[0].trim();
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
 * Primary entry point: find the BWW RR URL for a given show.
 *
 * @param {object} show - shows.json record; needs { title, openingDate }
 * @param {object} [opts]
 * @param {function} [opts.fetchAnchors] - override for testing; returns string[]
 * @returns {Promise<{ url: string|null, candidates: Array<{url:string, score:number}> }>}
 */
async function discoverBwwRoundupUrl(show, opts = {}) {
  const fetchAnchors = opts.fetchAnchors || fetchReviewsPageAnchors;
  const anchors = await fetchAnchors();
  const candidates = anchors
    .map(url => ({ url, score: scoreCandidate(url, show) }))
    .filter(c => c.score >= 10)              // must at least match title tokens
    .sort((a, b) => b.score - a.score);
  return { url: candidates[0]?.url || null, candidates };
}

module.exports = {
  discoverBwwRoundupUrl,
  fetchReviewsPageAnchors,
  scoreCandidate,
  slugMatchesShow,
  tokensFromTitle,
};
