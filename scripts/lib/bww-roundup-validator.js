/**
 * BWW Review Roundup content validator (shared module).
 *
 * Detects whether fetched HTML is a real BWW Review Roundup article
 * vs. the BWW homepage or a redirect. Used by both gather-reviews.js
 * and scrape-bww-reviews.js.
 */

/**
 * Check if HTML looks like a real BWW Review Roundup (not the homepage or a redirect).
 * BWW homepage contains "Review Roundup" in nav links but lacks article-specific markers.
 */
function isBWWRoundupContent(html) {
  if (!html.includes('Review Roundup')) return false;
  // Primary markers (full HTML with schema.org)
  if (html.includes('BlogPosting') || html.includes('articleBody') || html.includes('Photo Credit:')) return true;
  // Secondary markers (proxy-rendered HTML may strip schema.org but keep article content)
  // "Opens-on-Broadway" or "Opens-in-the-West-End" appear in roundup article URLs/titles
  if (html.includes('Opens-on-Broadway') || html.includes('Opens-On-Broadway') ||
      html.includes('Opens-in-the-West-End') || html.includes('Opens-In-London')) return true;
  // Fallback: if the page has >5000 chars and contains "Review Roundup" in the title area, it's likely real
  if (html.length > 5000 && (html.includes('<title') && html.includes('Review Roundup'))) return true;
  return false;
}

module.exports = { isBWWRoundupContent };
