'use strict';
/**
 * Second source for NYT Critic's Picks: the review page's own header label.
 *
 * Why (BRO-8286): data/nyt-critics-picks.json is scraped only from the NYT
 * spotlight page, and that page lags NYT's own review pages. Seven Guitars
 * (review 2026-11-24) carried "Critic's Pick" in its headline block while the
 * spotlight list still ended at Much Ado About Nothing (2026-11-19), so the
 * badge was missing on opening night.
 *
 * False-positive history: scripts/check-nyt-critics-pick.js regexed the whole
 * page and matched site chrome (the `criticsPick` CSS class, "More Critics'
 * Picks" widgets, related-article cards), ~10% false positives. This detector
 * never searches the page at large. It accepts only the label the reader sees
 * above THIS article's headline, in one of two encodings of that same label:
 *   A. the <p> label immediately before <h1 data-testid="headline">
 *   B. the article's own HeaderBasicBlock label in the embedded page JSON
 * "Critic's Notebook", "Critic's Choice" and the like do not match.
 *
 * Only ever ADDS URLs (the pick list is append-only), so a wrong negative is
 * harmless and a wrong positive is what the fixtures in
 * tests/fixtures/nyt-review-page guard against.
 */

const { canonicalPickUrl } = require('./nyt-pick-refresh-needed');

const HEADLINE_MARKER = 'data-testid="headline"';
// The label <p> closes its wrapper <div>, then the headline wrapper <div> opens
// and holds the <h1>: nothing else may sit between them. Anchored at the end of
// the text before the marker, so a "Critic's Pick" card elsewhere never matches.
const LABEL_LOOKBACK_CHARS = 700;
const LABEL_P_RE = /Critic's Pick\s*<\/p>\s*<\/div>\s*<div[^>]*>\s*<h1[^>]*$/;
const HEADER_BLOCK_LABEL_RE = /"__typename":"HeaderBasicBlock","label":\{[^}]*?"text":"Critic's Pick"/;

// A URL that checked negative is re-checked once more after this long (a pick
// label could be added after publication), then never again.
const MAX_NEGATIVE_CHECKS = 2;
const MIN_RECHECK_GAP_MS = 12 * 60 * 60 * 1000;
// A fetch that failed (blocked, paywall shell) is not a negative, but each try
// is a paid fetchPage() chain, so it backs off and gives up after a few tries
// (BRO-8286 review: 6 URLs x every 30 min x 3 days would otherwise be ~860 chains).
const MAX_FAILED_FETCHES = 4;
const FAIL_BACKOFF_MS = 60 * 60 * 1000;
const MAX_URLS_PER_RUN = 6;
// Entries in the negative cache older than this are dropped (the recency
// window for candidates is 3 days, so they can never be asked about again).
const STATE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

function normalizeQuotes(s) {
  return String(s || '').replace(/[‘’ʼ]|&#x27;|&#39;|&#8217;|&rsquo;|&apos;/gi, "'");
}

/** True when the page is an NYT article (has the headline element). */
function looksLikeArticlePage(html, url) {
  const text = String(html || '');
  if (!text.includes(HEADLINE_MARKER)) return false;
  if (!url) return true;
  try {
    const slug = new URL(url).pathname.split('/').pop().replace(/\.html$/, '');
    return !slug || text.includes(slug);
  } catch {
    return true;
  }
}

/**
 * True when the article's own header carries the "Critic's Pick" label.
 * Pure. Returns false for non-article pages (blocked, paywall shell, 404).
 */
function isCriticsPickPage(html) {
  const text = normalizeQuotes(html);
  const h = text.indexOf(HEADLINE_MARKER);
  if (h < 0) return false;
  const before = text.slice(Math.max(0, h - LABEL_LOOKBACK_CHARS), h);
  if (LABEL_P_RE.test(before)) return true;
  // Fallback if NYT reshuffles the DOM: the article's own header block in the
  // page JSON. Only the FIRST block counts; later ones belong to embedded or
  // related items. (Every real page checked 2026-11-25 had exactly one headline
  // and one header block; A alone classified all 9 correctly, B is redundancy.)
  const marker = '"__typename":"HeaderBasicBlock"';
  const j = text.indexOf(marker);
  if (j >= 0) {
    const next = text.indexOf(marker, j + marker.length);
    const end = next >= 0 ? Math.min(next, j + 600) : j + 600;
    if (HEADER_BLOCK_LABEL_RE.test(text.slice(j, end))) return true;
  }
  return false;
}

/**
 * Choose which candidate URLs to fetch this run, honouring the negative
 * cache. `state` is { [canonicalUrl]: { checks, lastCheckedAt } }.
 */
function selectUrlsToCheck({ urls, state = {}, now = new Date(), limit = MAX_URLS_PER_RUN }) {
  const out = [];
  for (const raw of urls || []) {
    const url = canonicalPickUrl(raw);
    if (!url || out.includes(url)) continue;
    const s = state[url];
    if (s) {
      if ((s.checks || 0) >= MAX_NEGATIVE_CHECKS) continue;
      const last = Date.parse(s.lastCheckedAt || '');
      if (Number.isFinite(last) && now.getTime() - last < MIN_RECHECK_GAP_MS) continue;
      if ((s.fails || 0) >= MAX_FAILED_FETCHES) continue;
      const lastFail = Date.parse(s.lastFailedAt || '');
      if (Number.isFinite(lastFail) && now.getTime() - lastFail < FAIL_BACKOFF_MS) continue;
    }
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

/** Drop negative-cache entries too old to matter. Pure. */
function pruneState(state = {}, now = new Date()) {
  const kept = {};
  for (const [url, s] of Object.entries(state)) {
    const last = Math.max(Date.parse((s && s.lastCheckedAt) || '') || 0, Date.parse((s && s.lastFailedAt) || '') || 0);
    if (last > 0 && now.getTime() - last <= STATE_RETENTION_MS) kept[url] = s;
  }
  return kept;
}

/**
 * Fetch each URL and classify it. `getPage(url)` resolves to the page HTML or
 * rejects. A page that is not recognisably the article (blocked, paywall
 * shell) counts as a failure, never as a negative, so it is retried.
 *
 * @returns {Promise<{picks: string[], negatives: string[], failures: {url: string, reason: string}[]}>}
 */
async function classifyReviewPages({ urls, getPage, shouldStop = () => false }) {
  const picks = [];
  const negatives = [];
  const failures = [];
  for (const url of urls) {
    if (shouldStop()) break;
    let html;
    try {
      html = await getPage(url);
    } catch (err) {
      failures.push({ url, reason: err && err.message ? err.message : String(err) });
      continue;
    }
    if (!looksLikeArticlePage(html, url)) {
      failures.push({ url, reason: 'fetched page is not the article (headline or slug missing)' });
      continue;
    }
    (isCriticsPickPage(html) ? picks : negatives).push(url);
  }
  return { picks, negatives, failures };
}

/** Fold one run's outcome (negatives, failed fetches) into the cache. Pure. */
function recordChecks(state = {}, { negatives = [], picks = [], failures = [] }, now = new Date()) {
  const next = { ...state };
  for (const url of picks) delete next[url];
  for (const url of negatives) {
    const prev = next[url] || {};
    next[url] = { ...prev, checks: (prev.checks || 0) + 1, lastCheckedAt: now.toISOString() };
  }
  for (const f of failures) {
    const url = f && f.url ? f.url : f;
    const prev = next[url] || {};
    next[url] = { ...prev, checks: prev.checks || 0, fails: (prev.fails || 0) + 1, lastFailedAt: now.toISOString() };
  }
  return pruneState(next, now);
}

module.exports = {
  isCriticsPickPage,
  looksLikeArticlePage,
  selectUrlsToCheck,
  classifyReviewPages,
  recordChecks,
  pruneState,
  MAX_NEGATIVE_CHECKS,
  MIN_RECHECK_GAP_MS,
  MAX_URLS_PER_RUN,
  MAX_FAILED_FETCHES,
  FAIL_BACKOFF_MS,
};
