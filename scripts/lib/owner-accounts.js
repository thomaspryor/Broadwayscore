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
  /^https?:\/\/(?:www\.)?broadwayscorecard\.com(?:\/|$)/i,
  /^https?:\/\/github\.com\/thomaspryor\/Broadwayscore(?:\/|$)/i,
  /^https?:\/\/bsky\.app\/profile\/(?:broadwayscorecard|bwayscorecard|thomaspryor)/i,
  /^https?:\/\/x\.com\/(?:broadwayscorecard|bwayscorecard|thepinkmusical|thomaspryor)(?:\/|$)/i,
  /^https?:\/\/twitter\.com\/(?:broadwayscorecard|bwayscorecard|thepinkmusical|thomaspryor)(?:\/|$)/i,
];

/**
 * Test if a URL belongs to an owner-controlled account/site.
 */
function isOwnerUrl(url) {
  if (!url) return false;
  return OWNER_URL_PATTERNS.some((re) => re.test(url));
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
    if (isOwnerAccount(m.source, m.author) || isOwnerUrl(m.url)) {
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
  isOwnerAccount,
  isOwnerUrl,
  filterOwnerAccounts,
};
