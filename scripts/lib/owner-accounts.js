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
  reddit: ['thomaspryor', 'thepinkmusical', 'broadwayscorecard'],
  x: ['broadwayscorecard', 'thomaspryor', 'thepinkmusical'],
  bluesky: ['broadwayscorecard.bsky.social', 'thomaspryor.bsky.social'],
  hn: ['thomaspryor', 'thepinkmusical'],
  github: ['thomaspryor'],
  // Safety net — matched on every platform in addition to the platform-specific list
  generic: ['broadwayscorecard', 'thomaspryor', 'thepinkmusical'],
};

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
    if (isOwnerAccount(m.source, m.author)) {
      dropped.push(m);
    } else {
      kept.push(m);
    }
  }
  return { kept, dropped };
}

module.exports = {
  OWNER_ACCOUNTS,
  isOwnerAccount,
  filterOwnerAccounts,
};
