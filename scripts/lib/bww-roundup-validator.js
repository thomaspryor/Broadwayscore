/**
 * BWW Review Roundup content validator (shared module).
 *
 * Detects whether fetched HTML is a real BWW Review Roundup article
 * vs. the BWW homepage or a redirect. Used by both gather-reviews.js
 * and scrape-bww-reviews.js.
 */

const { TRYOUT_URL_MARKERS } = require('./content-filters');

/**
 * Check if "Review Roundup" appears in the <title> tag (not just anywhere on the page).
 * The BWW homepage contains "Review Roundup" in teaser links but NOT in its title.
 */
function hasReviewRoundupInTitle(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch ? titleMatch[1].includes('Review Roundup') : false;
}

/**
 * Check if HTML looks like a real BWW Review Roundup (not the homepage or a redirect).
 *
 * On opening night, the BWW homepage contains "Review Roundup", "Opens-On-Broadway",
 * and other text in teaser links — but lacks article-specific schema.org markup and
 * does NOT have "Review Roundup" in the <title> tag.
 */
function isBWWRoundupContent(html) {
  if (!html.includes('Review Roundup')) return false;

  // Reject the BWW homepage early — its title starts with "BroadwayWorld:"
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch && titleMatch[1].includes('BroadwayWorld:')) return false;

  // Primary markers (full HTML with schema.org) — these never appear on the homepage
  if (html.includes('BlogPosting') || html.includes('articleBody') || html.includes('Photo Credit:')) return true;

  // Secondary markers (proxy-rendered HTML may strip schema.org but keep article content)
  // Require "Review Roundup" in the <title> tag to distinguish from homepage teaser links
  if (hasReviewRoundupInTitle(html)) {
    if (html.includes('Opens-on-Broadway') || html.includes('Opens-On-Broadway') ||
        html.includes('Opens-in-the-West-End') || html.includes('Opens-In-London')) return true;
  }

  // Fallback: require "Review Roundup" in the <title> tag (not just anywhere on the page)
  if (html.length > 5000 && hasReviewRoundupInTitle(html)) return true;

  return false;
}

// Stop words stripped before title matching — must be lowercase
const TITLE_STOP_WORDS = new Set(['the', 'and', 'for', 'from', 'with', 'that', 'this', 'its', 'a', 'an', 'of', 'in', 'on', 'at', 'by']);

// TRYOUT_URL_MARKERS lives in content-filters.js as a single source of truth.
// Re-imported above so the BWW slug validator stays aligned with the general
// SERP prefilter applied in url-discovery.js (Schmigadoon 2026 Bug #8).

/**
 * Normalize a show title into matchable words: lowercase, strip punctuation, remove stop words.
 * Mirrors the logic in findBWWRoundupLinkOnHomepage (gather-reviews.js).
 */
function normalizeTitleWords(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 0 && !TITLE_STOP_WORDS.has(w));
}

/**
 * Validate that a discovered BWW roundup URL slug actually matches the show being gathered.
 *
 * Prevents SERP returning the wrong show's roundup — e.g. the Becky Shaw BWW RR when
 * searching for "Proof Broadway 2026" (Becky Shaw mentions "Proof" in its Pulitzer context,
 * causing a spurious SERP match). Confirmed incident: 2026-04-16 opening night poller.
 *
 * Logic:
 *  - Single meaningful-word titles (e.g. "Proof", "Cats", "Wit"): require exact segment match
 *    in the URL slug. Prevents substring false positives ("fear" matching "fear-of-13").
 *  - 2-word titles: require both words present in slug (100%).
 *  - 3+ word titles: require ≥80% of meaningful words present in slug.
 *
 * Returns true (valid) when:
 *  - URL is null/empty (can't validate — don't block)
 *  - URL has no "Review-Roundup-" segment (unexpected format — don't block)
 *  - Title normalizes to zero words (edge case — don't block)
 *  - The slug matches the title per above rules
 *
 * Returns false (invalid) when a mismatch is detected.
 */
function validateBWWRoundupUrlMatchesShow(url, showTitle) {
  if (!url || !showTitle) return true; // can't validate, don't block

  const slugMatch = url.match(/Review-Roundup-(.+)/i);
  if (!slugMatch) return true; // unexpected URL format — don't block

  const slug = slugMatch[1].toLowerCase();

  // Reject tryout / pre-Broadway / regional variants of the same show
  for (const marker of TRYOUT_URL_MARKERS) {
    if (slug.includes(marker)) return false;
  }

  const slugSegments = new Set(slug.split(/[-_]/));

  const titleWords = normalizeTitleWords(showTitle);
  if (titleWords.length === 0) return true; // all stop words — can't validate

  // Single meaningful word: exact segment match only (prevents substring collisions)
  if (titleWords.length === 1) {
    return slugSegments.has(titleWords[0]);
  }

  // Multi-word: exact segment match (same as single-word) — prevents substring collisions
  // e.g. 'to' matching inside 'story', 'is' inside 'christmas', 'all' inside 'falls'
  const matchedCount = titleWords.filter(w => slugSegments.has(w)).length;
  const threshold = titleWords.length <= 2 ? 1.0 : 0.8;
  return matchedCount / titleWords.length >= threshold;
}

module.exports = { isBWWRoundupContent, validateBWWRoundupUrlMatchesShow };
