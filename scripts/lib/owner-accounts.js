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
//
// Subdomain matching is deliberately loose ((?:[a-z0-9-]+\.)*): Google SERPs
// surface owner properties under variant subdomains — secure.instagram.com
// (2026-04-17) and www-fallback.instagram.com (2026-06-27) both dodged
// (?:www\.)? and alerted as "new mentions". Path suffix allows /, ?, or end
// so query-string variants (…/bwayscorecard/?hl=bg) also match.
const OWNER_URL_PATTERNS = [
  // /_u/ and /stories/ are alternate Instagram profile-URL shapes for the same handles
  /^https?:\/\/(?:[a-z0-9-]+\.)*instagram\.com\/(?:_u\/|stories\/)?(?:bwayscorecard|broadwayscorecard|thomaspryor)(?:[/?#]|$)/i,
  // Instagram's auto-generated /popular/<brand> topic landing pages —
  // machine-built SEO pages aggregating the owner's own posts, not
  // third-party mentions (2026-07-26 leak). Deliberately NOT /explore/tags/:
  // hashtag pages aggregate third-party posts and are genuine signal.
  /^https?:\/\/(?:[a-z0-9-]+\.)*instagram\.com\/popular\/(?:broadway-?scorecard|bway-?scorecard)(?:[/?#]|$)/i,
  /^https?:\/\/(?:[a-z0-9-]+\.)*threads\.(?:com|net)\/@?(?:bwayscorecard|broadwayscorecard|thomaspryor)(?:[/?#]|$)/i,
  // Every apex domain the owner controls, not just broadwayscorecard.com:
  // several are aliases on the same Vercel project that SERVE the full site
  // (mirror, canonical → broadwayscorecard.com) rather than redirecting, so
  // Google indexes them as separate sites and they surface as "mentions"
  // (theaterscorecard.com leak, 2026-07-27). Source of truth: Vercel account
  // domains (GET /v5/domains) — update here when attaching a new domain.
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:broadwayscorecard|theaterscorecard|showscorecard|operascorecard|offbroadwayscorecard|westendscorecard|broadwaymetascore|eveandadammusical)\.com(?:[/?#]|$)/i,
  /^https?:\/\/(?:[a-z0-9-]+\.)*scorekeep\.co(?:[/?#]|$)/i,
  // Owner Vercel deployment URLs (broadwayscore.vercel.app + preview aliases)
  /^https?:\/\/broadwayscore[a-z0-9-]*\.vercel\.app(?:[/?#]|$)/i,
  /^https?:\/\/(?:www\.)?github\.com\/thomaspryor\/Broadwayscore(?:\/|$)/i,
  // Full owner handles with a terminating boundary — a bare "broadwayscorecard"
  // prefix would also swallow third parties like broadwayscorecardfan.bsky.social
  /^https?:\/\/bsky\.app\/profile\/(?:broadwayscorecard|bwayscorecard|thomaspryor)(?:\.bsky\.social)?(?:[/?#]|$)/i,
  /^https?:\/\/(?:[a-z0-9-]+\.)*x\.com\/(?:broadwayscorecard|bwayscorecard|thepinkmusical|thomaspryor)(?:[/?#]|$)/i,
  /^https?:\/\/(?:[a-z0-9-]+\.)*twitter\.com\/(?:broadwayscorecard|bwayscorecard|thepinkmusical|thomaspryor)(?:[/?#]|$)/i,
  // Owner Substack newsletter
  /^https?:\/\/(?:www\.)?broadwayscorecard\.substack\.com(?:\/|$)/i,
  // Owner podcast (Broadway Breakdown, Apple Podcasts ID 1260430031)
  /^https?:\/\/(?:www\.)?podscan\.fm\/podcasts\/broadway-breakdown/i,
  /^https?:\/\/podcasts\.apple\.com\/.*?(?:broadway-breakdown|id1260430031)/i,
  /^https?:\/\/open\.spotify\.com\/show\/.*broadway.?breakdown/i,
  // Owner social profiles on additional platforms (fb.com/fb.me are
  // Facebook's redirect shorteners for the same profile paths)
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:facebook\.com|fb\.com|fb\.me)\/(?:broadwayscorecard|bwayscorecard)(?:[/?#]|$)/i,
  /^https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\/@(?:bwayscorecard|broadwayscorecard)(?:[/?#]|$)/i,
  /^https?:\/\/(?:[a-z0-9-]+\.)*youtube\.com\/@(?:bwayscorecard|broadwayscorecard)(?:[/?#]|$)/i,
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
