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

/**
 * Canonicalize a URL so the same logical resource always hashes to the
 * same key, even when SERP returns localized / parameterized variants.
 *
 * Specifically handles:
 *   - Apple Podcasts: strip country code (in/dk/us/uk/de/...). Google SERP
 *     rotates which country it surfaces; same podcast hashes differently
 *     without normalization. Pattern: /podcasts.apple.com/{cc}/podcast/...
 *   - Apple Music: same locale prefix
 *   - Wikipedia: strip language subdomain (en./es./de./...) — same article
 *   - YouTube: normalize /shorts/{id} → /watch?v={id}
 *   - Trailing slashes, lowercase hostname
 *   - Tracking query params (utm_*, fbclid, gclid, ref, source, igshid, ...)
 *   - URL fragments
 *
 * Returns the original URL string on any parse error (graceful fallback).
 */
function canonicalizeUrl(rawUrl) {
  if (!rawUrl) return '';
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return String(rawUrl);
  }

  url.hostname = url.hostname.toLowerCase();

  // Apple Podcasts country code: /{cc}/podcast/... → /podcast/...
  if (/(^|\.)podcasts\.apple\.com$/.test(url.hostname)) {
    url.pathname = url.pathname.replace(/^\/[a-z]{2}\/podcast\//i, '/podcast/');
  }

  // Apple Music: /{cc}/... → /...
  if (/(^|\.)music\.apple\.com$/.test(url.hostname)) {
    url.pathname = url.pathname.replace(/^\/[a-z]{2}\//i, '/');
  }

  // Wikipedia language subdomain: en.wikipedia.org → wikipedia.org
  if (/\.wikipedia\.org$/.test(url.hostname)) {
    url.hostname = 'wikipedia.org';
  }

  // YouTube /shorts/{id} → canonical /watch?v={id}
  if (/(^|\.)youtube\.com$/.test(url.hostname)) {
    const m = url.pathname.match(/^\/shorts\/([\w-]+)/);
    if (m) {
      url.pathname = '/watch';
      url.searchParams.set('v', m[1]);
    }
  }

  // Strip tracking query params
  const tracking = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
                    'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'ref_url',
                    'source', '_ga', 'igshid', 'si', '__twitter_impression', 'cmp'];
  for (const p of tracking) url.searchParams.delete(p);

  url.hash = '';

  // Normalize trailing slash on pathname (but keep root /)
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.toString();
}

// Stable hash for Google web URLs (where we have no native ID).
// Hashes the canonical form so SERP variants of the same resource collapse.
function urlHash(url) {
  return crypto.createHash('sha1').update(canonicalizeUrl(url)).digest('hex').slice(0, 16);
}

/**
 * Drop SERP results that we can't reliably attribute or that are owner-controlled
 * but appear under bare URLs that the standard owner filter misses.
 *
 * - Instagram /p/{id}/ and /reel/{id}/ — Google strips username from these,
 *   so we can't tell if it's the owner's @bwayscorecard post or someone else's.
 *   100% of Instagram bare URLs seen so far have been owner posts. Drop them.
 * - TikTok /video/{id} without @user — same problem
 *
 * Real Instagram/TikTok mentions of broadwayscorecard would appear in the
 * user's own platform notifications anyway. SERP coverage is unreliable.
 */
function isUnattributableSocialUrl(url) {
  if (!url) return false;
  // Bare Instagram post / reel without username path
  if (/^https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/[^/]+/i.test(url)) return true;
  // Bare TikTok video without @username
  if (/^https?:\/\/(?:www\.)?tiktok\.com\/video\/\d+/i.test(url)) return true;
  // Threads bare post URL
  if (/^https?:\/\/(?:www\.)?threads\.(?:net|com)\/post\/[^/]+/i.test(url)) return true;
  return false;
}

/**
 * Detect Google's opaque redirect/AMP cache URLs that can't be resolved.
 * Google SGE/AI Overview results sometimes return /goto?url=CAE... or
 * webcache.googleusercontent.com URLs instead of the actual destination.
 * These break dedup (each redirect URL is unique) and owner filtering
 * (no real hostname to match). Skip them — the same content should
 * appear with a real URL in a different SERP call or free source.
 */
function isUnresolvableRedirectUrl(url) {
  if (!url) return true;
  const s = String(url);
  // Relative paths (Google's /goto?url=... redirect)
  if (s.startsWith('/')) return true;
  // Google cache/AMP wrappers
  if (/^https?:\/\/(?:webcache\.googleusercontent\.com|google\.com\/amp)/i.test(s)) return true;
  // Must have a proper HTTP(S) scheme
  try {
    const parsed = new URL(s);
    if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  } catch {
    return true;
  }
  return false;
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
      // Skip Google's opaque redirect URLs (break dedup + owner filtering)
      if (isUnresolvableRedirectUrl(r.url)) continue;
      // Skip sources we already cover natively
      if (/reddit\.com|news\.ycombinator\.com|bsky\.app|x\.com|twitter\.com/i.test(r.url)) continue;
      // Skip Instagram/TikTok/Threads bare URLs we can't attribute
      if (isUnattributableSocialUrl(r.url)) continue;
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
      // Skip Google's opaque redirect URLs (break dedup + owner filtering)
      if (isUnresolvableRedirectUrl(r.url)) continue;
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
    return { mentions: [], counts: { x: 0, google: 0 } };
  }

  // Google News dropped 2026-05-08 — redundant with theater outlets we already
  // scrape directly (NYT/Variety/Playbill/etc.). Lowest-signal SERP source per
  // April 2026 Bright Data cost review.
  const results = await Promise.allSettled([
    fetchXMentions(keywords, opts),
    fetchGoogleWebMentions(keywords, opts),
  ]);

  const labels = ['x', 'google'];
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
  _internal: { parseXUrl, buildQuery, urlHash, canonicalizeUrl, isUnattributableSocialUrl, isUnresolvableRedirectUrl },
};
