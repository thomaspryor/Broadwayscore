'use strict';

/**
 * Heuristic detector for outlet NEWS articles ingested as review text:
 * press releases, "first look" / "the lowdown" / "everything you need to
 * know" pieces that were fetched under contentTier=complete but never
 * evaluate the production.
 *
 * scripts/lib/non-review-patterns.js's heuristicClassify() (the corpus-wide
 * Layer 1 gate) doesn't catch this class — these articles are long and
 * promotional, and often quote glowing adjectives ("acclaimed",
 * "award-winning") that trip its REVIEW_INDICATORS and suppress the match.
 * They also never enter the LLM ensemble at all when the source URL is on
 * an aggregator/listing domain (isBlockedReviewUrl) — isScoreable() filters
 * them out before ensemble-scoreability-check ever runs, so rejectionReason
 * is never stamped and the file sits unflagged indefinitely
 * (scripts/lib/found-outlet-ids.js then reads the outlet as "found").
 *
 * Deliberately narrow: requires a /news/ URL path segment AND a matching
 * promotional headline phrase AND no star rating in the text, so a genuine
 * review hosted under a site's /news/ section (e.g. westendtheatre.com
 * publishes some reviews under /news/reviews/) is not misclassified.
 */

const NEWS_HEADLINE_PATTERNS = [
  /\bthe\s+lowdown\b/i,
  /\badds?\s+(?:an?\s+)?extra\s+performance/i,
  /\breleases?\s+(?:a|an|its|new)?\s*(?:exclusive\s+)?first\s+(?:listen|look)\b/i,
  /\bexclusive\s+first\s+(?:listen|look)\b/i,
  /\beverything\s+you\s+need\s+to\s+know\b/i,
  /\bfinal\s+casting\s+announced\b/i,
  /\bcasting\s+(?:has\s+been\s+)?announced\b/i,
  /\bfirst[-\s]look\s+photos?\b/i,
];

const STAR_RATING_PATTERN = /(\d(?:\.\d)?\s*(?:out of|\/)\s*5\s*stars?)|★{1,5}|(\brating:\s*[A-F][+-]?\b)/i;

function hasNewsUrlPath(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().split('/').filter(Boolean).includes('news');
  } catch {
    return false;
  }
}

// URL slugs use hyphens, not spaces ("adds-an-extra-performance") — normalize
// to whitespace so the same \s+-based patterns match both the fetched text
// and the URL slug itself.
function slugToWords(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    return decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, ' ');
  } catch {
    return '';
  }
}

function matchesNewsHeadline(text) {
  if (!text) return null;
  const opening = text.slice(0, 400);
  for (const pattern of NEWS_HEADLINE_PATTERNS) {
    const m = opening.match(pattern);
    if (m) return m[0];
  }
  return null;
}

/**
 * @param {object} data - review-text file contents ({url, fullText, ...})
 * @returns {{isNewsArticle: boolean, reasons: string[]}}
 */
function detectNewsArticle(data) {
  if (!data) return { isNewsArticle: false, reasons: [] };
  const url = data.url;
  const text = data.fullText || '';
  const reasons = [];

  const urlIsNews = hasNewsUrlPath(url);
  if (urlIsNews) reasons.push('url-path:/news/');

  const headlineMatch = matchesNewsHeadline(text) || matchesNewsHeadline(slugToWords(url));
  if (headlineMatch) reasons.push(`headline-pattern:"${headlineMatch}"`);

  const hasStarRating = STAR_RATING_PATTERN.test(text);
  if (!hasStarRating) reasons.push('no-star-rating');

  const isNewsArticle = urlIsNews && !!headlineMatch && !hasStarRating;
  return { isNewsArticle, reasons };
}

module.exports = {
  detectNewsArticle,
  hasNewsUrlPath,
  matchesNewsHeadline,
  slugToWords,
  NEWS_HEADLINE_PATTERNS,
  STAR_RATING_PATTERN,
};
