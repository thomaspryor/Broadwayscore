/**
 * owner-accounts.js
 *
 * Central list of accounts owned by or representing BroadwayScorecard.
 * Used by the brand mention monitor (and any other tool that needs to
 * distinguish self-posts from organic third-party mentions).
 *
 * When thomaspryor posts his own scores to r/Broadway, those should NOT
 * be treated as brand mentions — they're owned content. The monitor
 * filters on this list before dedup so owner posts never enter state.
 *
 * Usage:
 *   const { isOwnerAccount, OWNER_ACCOUNTS } = require('./lib/owner-accounts');
 *   if (isOwnerAccount('reddit', post.author)) return;  // drop before dedup
 */

/**
 * Accounts to filter, keyed by platform.
 * Platform names: 'reddit', 'x', 'bluesky', 'hn', 'github', 'generic'
 * 'generic' matches on any platform as a safety net for cross-platform
 * username reuse.
 *
 * All entries are lowercased for case-insensitive matching.
 */
const OWNER_ACCOUNTS = {
  reddit: ['thomaspryor', 'thepinkmusical', 'broadwayscorecard', 'bwayscorecard'],
  x: ['broadwayscorecard', 'bwayscorecard', 'thomaspryor', 'thepinkmusical'],
  bluesky: ['broadwayscorecard.bsky.social', 'bwayscorecard.bsky.social', 'thomaspryor.bsky.social'],
  hn: ['thomaspryor', 'thepinkmusical'],
  github: ['thomaspryor'],
  instagram: ['bwayscorecard', 'broadwayscorecard', 'thomaspryor'],
  threads: ['bwayscorecard', 'broadwayscorecard', 'thomaspryor'],
  // Safety net — matched on every platform in addition to the platform-specific list
  generic: ['broadwayscorecard', 'bwayscorecard', 'thomaspryor', 'thepinkmusical'],
};

/**
 * Owner-controlled URL patterns. Some SERP results (Instagram posts,
 * GitHub issues) don't surface an author field — so we filter by URL
 * path as a second safety net.
 */
// NOTE: Instagram post URLs (/p/POSTID/) don't surface the author in the
// path, so we cannot filter Instagram POSTS by URL alone. We filter the
// *profile* URL pattern only (instagram.com/bwayscorecard/…). If Instagram
// becomes a significant signal source, we'll need a scraper that resolves
// the post's owner handle. For now, non-profile Instagram URLs fall through
// to the content-based keyword check and are evaluated by the drafter.
const OWNER_URL_PATTERNS = [
  /^https?:\/\/(?:www\.)?instagram\.com\/(?:bwayscorecard|broadwayscorecard)(?:\/|$)/i,
  /^https?:\/\/(?:www\.)?threads\.(?:com|net)\/@?(?:bwayscorecard|broadwayscorecard)(?:\/|$)/i,
  /^https?:\/\/(?:www\.)?broadwayscorecard\.com(?:\/|$)/i,
  /^https?:\/\/github\.com\/thomaspryor\/Broadwayscore(?:\/|$)/i,
  /^https?:\/\/bsky\.app\/profile\/(?:broadwayscorecard|bwayscorecard|thomaspryor)/i,
  /^https?:\/\/x\.com\/(?:broadwayscorecard|bwayscorecard|thepinkmusical|thomaspryor)(?:\/|$)/i,
  /^https?:\/\/twitter\.com\/(?:broadwayscorecard|bwayscorecard|thepinkmusical|thomaspryor)(?:\/|$)/i,
  // Owner Substack newsletter
  /^https?:\/\/(?:www\.)?broadwayscorecard\.substack\.com(?:\/|$)/i,
  // Owner podcast (Broadway Breakdown, Apple Podcasts ID 1260430031)
  /^https?:\/\/(?:www\.)?podscan\.fm\/podcasts\/broadway-breakdown/i,
  /^https?:\/\/podcasts\.apple\.com\/.*?(?:broadway-breakdown|id1260430031)/i,
  /^https?:\/\/open\.spotify\.com\/show\/.*broadway.?breakdown/i,
  // Owner social profiles on additional platforms
  /^https?:\/\/(?:www\.)?facebook\.com\/(?:broadwayscorecard|bwayscorecard)(?:\/|$)/i,
  /^https?:\/\/(?:www\.)?tiktok\.com\/@(?:bwayscorecard|broadwayscorecard)(?:\/|$)/i,
  /^https?:\/\/(?:www\.)?youtube\.com\/@(?:bwayscorecard|broadwayscorecard)(?:\/|$)/i,
];

/**
 * Content fingerprints that identify owner-posted material even when the
 * URL is opaque (Google redirect) or from a third-party aggregator.
 * Matched case-insensitively against title + excerpt.
 *
 * Each entry is a regex. Keep patterns specific enough to avoid false
 * positives on genuine third-party mentions that happen to quote BWSC.
 */
const OWNER_CONTENT_FINGERPRINTS = [
  // Buffer social post CTA signature
  /check the full rankings at broadwayscorecard\.com/i,
  // Substack podcast boilerplate
  /broadwayscorecard\.com\s+this is a public episode/i,
  // Substack newsletter byline
  /substack\s+[·•]\s+broadwayscorecard\.com/i,
  // Owner's Threads reply-comments under third-party posts (@officialbroadwayworld
  // etc.): Google's snippet for the post page surfaces the owner's comment because
  // it contains the brand term, so the mention's author/URL are the third party's.
  // Fingerprint the actual posted comment texts — specific phrasings, not generic
  // CTAs, so genuine third-party recommendations still pass.
  /could brandon uranowitz split the best actor vote/i,
  /check out more tony predictions at broadwayscorecard\.com/i,
  /find more (?:prediction data|stats to impress your tony part(?:y|ies)) at broadwayscorecard\.com/i,
  /do you have a favorite supporting performance this season\?\s*broadwayscorecard\.com/i,
  /check out what audiences thought of all of the nominated revivals!\s*broadwayscorecard\.com/i,
];

/**
 * Test if a URL belongs to an owner-controlled account/site.
 */
function isOwnerUrl(url) {
  if (!url) return false;
  return OWNER_URL_PATTERNS.some((re) => re.test(url));
}

/**
 * Test if mention content matches a known owner-posted fingerprint.
 * @param {string} title
 * @param {string} excerpt
 * @returns {boolean}
 */
function isOwnerContent(title, excerpt) {
  const blob = `${title || ''} ${excerpt || ''}`;
  if (!blob.trim()) return false;
  return OWNER_CONTENT_FINGERPRINTS.some((re) => re.test(blob));
}

/**
 * Test whether a given (platform, author) pair is an owner account.
 * Matching is case-insensitive. Author can be prefixed with @ or u/; those are stripped.
 *
 * @param {string} platform — one of 'reddit', 'x', 'bluesky', 'hn', 'github', or any string
 * @param {string} author — username/handle, may include @ or u/ prefix
 * @returns {boolean} true if the author should be filtered as an owner account
 */
function isOwnerAccount(platform, author) {
  if (!author) return false;
  const normalized = String(author)
    .trim()
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/^u\//, '')
    .replace(/^\/?u\//, '');
  if (!normalized) return false;

  const platformKey = String(platform || '').toLowerCase();
  const platformList = OWNER_ACCOUNTS[platformKey] || [];
  if (platformList.includes(normalized)) return true;

  // Generic safety net — catches cross-platform username reuse
  if (OWNER_ACCOUNTS.generic.includes(normalized)) return true;

  return false;
}

/**
 * Filter an array of mention objects, removing any whose author matches an
 * owner account on their platform. Mutates nothing; returns a new array.
 *
 * @param {Array<{source: string, author: string}>} mentions
 * @returns {{kept: Array, dropped: Array}} — kept items + dropped for logging
 */
function filterOwnerAccounts(mentions) {
  const kept = [];
  const dropped = [];
  for (const m of mentions || []) {
    if (isOwnerAccount(m.source, m.author) || isOwnerUrl(m.url) || isOwnerContent(m.title, m.excerpt)) {
      dropped.push(m);
    } else {
      kept.push(m);
    }
  }
  return { kept, dropped };
}

module.exports = {
  OWNER_ACCOUNTS,
  OWNER_URL_PATTERNS,
  OWNER_CONTENT_FINGERPRINTS,
  isOwnerAccount,
  isOwnerUrl,
  isOwnerContent,
  filterOwnerAccounts,
};
