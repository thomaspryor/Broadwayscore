/**
 * Resolve a Google News RSS wrapper link (news.google.com/rss/articles/CBMi...)
 * to the publisher URL over plain HTTP, and fetch the feed itself the same way
 * (BRO-6589).
 *
 * The poller used to open every wrapper in Playwright and wait up to 20s for
 * the publisher page; most waits timed out. Google's own news page resolves
 * the wrapper with two small requests: the article page carries a signature
 * (data-n-a-sg) and timestamp (data-n-a-ts), and the batchexecute "Fbv4je"
 * RPC exchanges them for the URL ("garturlres"). ~250ms per link.
 *
 * Talks to news.google.com only (not a scraping provider, so not fetchPage).
 * Returns null on any failure; callers fall back to the Playwright path. If
 * Google changes the RPC shape this quietly returns null, so callers log a
 * decoded N/M count to make that visible.
 */

const ARTICLE_BASE = 'https://news.google.com/rss/articles/';
const BATCH_URL = 'https://news.google.com/_/DotsSplashUi/data/batchexecute';
const TIMEOUT_MS = 8000;

/** Wrapper id from a news.google.com/rss/articles/<id> link, or null. */
function wrapperId(link) {
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' || u.hostname !== 'news.google.com') return null;
    const m = u.pathname.match(/^\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

/** Signature + timestamp from Google's article page HTML, or null. */
function parseDecodeParams(html) {
  const sg = String(html || '').match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = String(html || '').match(/data-n-a-ts="(\d+)"/)?.[1];
  return sg && ts ? { sg, ts: Number(ts) } : null;
}

function batchBody(id, { sg, ts }) {
  const inner = JSON.stringify(['garturlreq',
    [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id, ts, sg]);
  return 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
}

/** Publisher URL from a batchexecute response body, or null. */
function parseBatchResponse(text) {
  const body = String(text || '').replace(/^\)\]\}'\s*/, '');
  let outer;
  try { outer = JSON.parse(body); } catch { return null; }
  for (const row of Array.isArray(outer) ? outer : []) {
    if (!Array.isArray(row) || row[0] !== 'wrb.fr' || row[1] !== 'Fbv4je' || typeof row[2] !== 'string') continue;
    try {
      const inner = JSON.parse(row[2]);
      if (inner[0] === 'garturlres' && /^https?:\/\//.test(inner[1] || '')) return inner[1];
    } catch { /* malformed row */ }
  }
  return null;
}

/**
 * @param {string} link - Google News RSS item link
 * @param {object} [opts]
 * @param {function} [opts.fetchImpl] - test seam, defaults to global fetch
 * @returns {Promise<string|null>} publisher URL, or null when it can't be decoded
 */
async function decodeGoogleNewsLink(link, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const id = wrapperId(link);
  if (!id) return null;
  try {
    const page = await fetchImpl(ARTICLE_BASE + id, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!page.ok) return null;
    const params = parseDecodeParams(await page.text());
    if (!params) return null;
    const res = await fetchImpl(BATCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: batchBody(id, params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseBatchResponse(await res.text());
  } catch { return null; }
}

/**
 * The Google News RSS feed over plain HTTP, or null (callers fall back to
 * fetchPage). Only news.google.com URLs are fetched.
 */
async function fetchGoogleNewsFeed(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'news.google.com') return null;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const xml = await res.text();
    // An RSS channel with no items is the normal pre-review state; only non-RSS (consent page) falls back.
    return /<rss[\s>]/.test(xml) && xml.includes('<channel') ? xml : null;
  } catch { return null; }
}

module.exports = { decodeGoogleNewsLink, fetchGoogleNewsFeed, wrapperId, parseDecodeParams, parseBatchResponse };
