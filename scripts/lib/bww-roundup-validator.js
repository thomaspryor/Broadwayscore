/**
 * BWW Review Roundup content validator (shared module).
 *
 * Detects whether fetched HTML is a real BWW Review Roundup article
 * vs. the BWW homepage or a redirect. Used by both gather-reviews.js
 * and scrape-bww-reviews.js.
 */

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

module.exports = { isBWWRoundupContent };
