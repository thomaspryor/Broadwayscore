/**
 * brand-mention-serp.js
 *
 * Paid SERP sources for the brand mention monitor: X/Twitter, Google web,
 * Google News. All queries go through scripts/lib/url-discovery.js's
 * serpQuery() which handles the SB → BrightData fallback chain and
 * date-window filtering. We only do normalization here.
 *
 * Output shape matches brand-mention-sources.js so the orchestrator can
 * merge results uniformly:
 *   { id, source, url, title, excerpt, author, publishedAt, detectedAt, raw }
 *
 * Note: SERP results don't always surface the author. For X, we parse the
 * handle from the URL path (x.com/{handle}/status/{id}). For Google web
 * results, author is left null.
 */

const crypto = require('crypto');
const { serpQuery } = require('./url-discovery');

const DEFAULT_KEYWORDS = ['broadwayscorecard', 'broadwayscorecard.com'];

function nowIso() {
  return new Date().toISOString();
}

// Stable hash for Google web URLs (where we have no native ID)
function urlHash(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
}

// Parse X/Twitter tweet ID + handle from a status URL
// Accepts: https://x.com/foo/status/123, https://twitter.com/foo/status/123
function parseXUrl(url) {
  const m = String(url).match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/);
  if (!m) return null;
  const handle = m[1];
  // Filter obvious non-user paths
  if (['i', 'intent', 'search', 'home', 'explore', 'hashtag'].includes(handle)) return null;
  return { handle, tweetId: m[2] };
}

/**
 * Build a Google SERP query that excludes the brand's own domain so we
 * only get third-party mentions.
 */
function buildQuery(keyword, extraFilter = '') {
  const base = `"${keyword}"`;
  const exclude = '-site:broadwayscorecard.com -site:github.com/thomaspryor';
  return `${base} ${extraFilter} ${exclude}`.trim();
}

async function runSerp(keyword, filter, opts = {}) {
  const query = buildQuery(keyword, filter);
  try {
    const results = await serpQuery(query, {
      nbResults: opts.nbResults || 20,
      dateRange: opts.dateRange || null,
      preferSpeed: true, // use ScrapingBee first for faster runs
      log: opts.verbose ? console.log : () => {},
    });
    return results || [];
  } catch (e) {
    console.warn(`[serp] query "${query}" failed: ${e.message}`);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────
// X/Twitter via Google SERP (site: filter)
// ──────────────────────────────────────────────────────────────────────────

async function fetchXMentions(keywords = DEFAULT_KEYWORDS, opts = {}) {
  const mentions = [];
  const detected = nowIso();

  for (const keyword of keywords) {
    // Both x.com and twitter.com — twitter.com still gets indexed for legacy URLs
    for (const site of ['x.com', 'twitter.com']) {
      const results = await runSerp(keyword, `site:${site}`, opts);
      for (const r of results) {
        const parsed = parseXUrl(r.url);
        if (!parsed) continue;
        // Confirm keyword appears in title or snippet (SERP can be fuzzy)
        const blob = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
        if (!blob.includes(keyword.toLowerCase())) continue;

        mentions.push({
          id: `x:${parsed.tweetId}`,
          source: 'x',
          url: `https://x.com/${parsed.handle}/status/${parsed.tweetId}`,
          title: r.title || null,
          excerpt: (r.snippet || '').slice(0, 500),
          author: parsed.handle,
          publishedAt: null, // SERP doesn't give us the post timestamp reliably
          detectedAt: detected,
          raw: { matchedKeyword: keyword, serpSite: site },
        });
      }
    }
  }

  const seen = new Set();
  return mentions.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Google web (general)
// ──────────────────────────────────────────────────────────────────────────

async function fetchGoogleWebMentions(keywords = DEFAULT_KEYWORDS, opts = {}) {
  const mentions = [];
  const detected = nowIso();

  for (const keyword of keywords) {
    const results = await runSerp(keyword, '', opts);
    for (const r of results) {
      if (!r.url) continue;
      // Skip sources we already cover natively
      if (/reddit\.com|news\.ycombinator\.com|bsky\.app|x\.com|twitter\.com/i.test(r.url)) continue;
      // Confirm keyword appears in title or snippet
      const blob = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
      if (!blob.includes(keyword.toLowerCase())) continue;

      mentions.push({
        id: `google:${urlHash(r.url)}`,
        source: 'google',
        url: r.url,
        title: r.title || null,
        excerpt: (r.snippet || '').slice(0, 500),
        author: null,
        publishedAt: null,
        detectedAt: detected,
        raw: { matchedKeyword: keyword },
      });
    }
  }

  const seen = new Set();
  return mentions.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Google News — piggybacks on serpQuery with a news-site filter
// ──────────────────────────────────────────────────────────────────────────

// Known theater-news sites that serpQuery's general Google search catches.
// This is lighter weight than using Google News's tbm=nws which serpQuery
// doesn't currently expose as a first-class option.
const NEWS_SITE_FILTER = [
  'nytimes.com',
  'playbill.com',
  'broadwayworld.com',
  'variety.com',
  'hollywoodreporter.com',
  'deadline.com',
  'theguardian.com',
  'thestage.co.uk',
  'whatsonstage.com',
].join(' OR site:');

async function fetchGoogleNewsMentions(keywords = DEFAULT_KEYWORDS, opts = {}) {
  const mentions = [];
  const detected = nowIso();

  for (const keyword of keywords) {
    const results = await runSerp(keyword, `(site:${NEWS_SITE_FILTER})`, opts);
    for (const r of results) {
      if (!r.url) continue;
      const blob = `${r.title || ''} ${r.snippet || ''}`.toLowerCase();
      if (!blob.includes(keyword.toLowerCase())) continue;

      // Tag forum threads as interactive (drafter can respond). Regular
      // news articles stay as `news` (no-reply).
      const isForum = /forum\./i.test(r.url) || /\/forum\//i.test(r.url);
      mentions.push({
        id: `news:${urlHash(r.url)}`,
        source: isForum ? 'forum' : 'news',
        url: r.url,
        title: r.title || null,
        excerpt: (r.snippet || '').slice(0, 500),
        author: null,
        publishedAt: null,
        detectedAt: detected,
        raw: { matchedKeyword: keyword },
      });
    }
  }

  const seen = new Set();
  return mentions.filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Orchestrator: fetch all paid sources in parallel
// ──────────────────────────────────────────────────────────────────────────

async function fetchPaidSources(keywords = DEFAULT_KEYWORDS, opts = {}) {
  // No SERP keys at all? Skip everything gracefully.
  if (!process.env.SCRAPINGBEE_API_KEY && !process.env.BRIGHTDATA_TOKEN) {
    console.warn('[serp] neither SCRAPINGBEE_API_KEY nor BRIGHTDATA_TOKEN set — skipping paid SERP sources');
    return { mentions: [], counts: { x: 0, google: 0, news: 0 } };
  }

  const results = await Promise.allSettled([
    fetchXMentions(keywords, opts),
    fetchGoogleWebMentions(keywords, opts),
    fetchGoogleNewsMentions(keywords, opts),
  ]);

  const labels = ['x', 'google', 'news'];
  const out = [];
  const counts = {};

  results.forEach((r, idx) => {
    const label = labels[idx];
    if (r.status === 'fulfilled') {
      counts[label] = r.value.length;
      out.push(...r.value);
    } else {
      counts[label] = `ERROR: ${r.reason && r.reason.message}`;
      console.warn(`[${label}] fatal: ${r.reason && r.reason.message}`);
    }
  });

  return { mentions: out, counts };
}

module.exports = {
  fetchXMentions,
  fetchGoogleWebMentions,
  fetchGoogleNewsMentions,
  fetchPaidSources,
  // exported for tests
  _internal: { parseXUrl, buildQuery, urlHash },
};
