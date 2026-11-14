'use strict';

/**
 * Pure parsing/decision functions for the Broadway.com audience scraper.
 * Extracted so scripts/scrape-broadway-com-audience.test.mjs can require()
 * the real logic instead of copying it (CLAUDE.md rule 15).
 */

/**
 * Detect bot challenge pages (Cloudflare/Fastly, etc.) that return a valid
 * HTTP 200 but no real content — small pages with known challenge markers.
 */
function isBotChallenge(html) {
  return html.length < 10000 && (
    html.includes('Client Challenge') ||
    html.includes('Just a moment') ||
    html.includes('cf-browser-verification') ||
    html.includes('_fs-ch-')
  );
}

/**
 * Extract aggregateRating from JSON-LD on a Broadway.com show page.
 * Returns { ratingValue, ratingCount } or null if not found.
 */
function extractJsonLdRating(html) {
  const jsonLdPattern = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = jsonLdPattern.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const items = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (item.aggregateRating) {
          const rating = item.aggregateRating;
          const ratingValue = parseFloat(rating.ratingValue);
          const ratingCount = parseInt(rating.ratingCount || rating.reviewCount, 10);

          if (!isNaN(ratingValue) && !isNaN(ratingCount) && ratingCount > 0) {
            return { ratingValue, ratingCount };
          }
        }
      }
    } catch {
      // Invalid JSON — skip this block
    }
  }

  return null;
}

/**
 * Fallback: extract rating from rendered HTML when JSON-LD is absent.
 * Looks for patterns like "Customer Reviews (270)" and a nearby score like "4.8".
 * Returns { ratingValue, ratingCount } or null.
 */
function extractHtmlRating(html) {
  // Pattern 1: "Customer Reviews (N)" — count in parentheses
  const countMatch = html.match(/Customer\s+Reviews?\s*\((\d+)\)/i);
  if (!countMatch) return null;
  const ratingCount = parseInt(countMatch[1], 10);
  if (!ratingCount || ratingCount < 1) return null;

  // Pattern 2: Standalone score near the reviews section
  // Look for a rating value like "4.8" in the vicinity (within 2000 chars of "Customer Reviews")
  const countIdx = html.indexOf(countMatch[0]);
  const vicinity = html.substring(Math.max(0, countIdx - 1000), countIdx + 2000);

  // Look for a decimal rating (1.0-5.0) that appears as text content, not in URLs
  // Common patterns: ">4.8<", ">4.8 ", aria-label with rating
  const ratingPatterns = [
    // Score in text content: >4.8< or >4.8 out of
    />\s*([1-5]\.\d)\s*</,
    // aria-label pattern
    /aria-label="([1-5]\.\d)/,
    // Score followed by "out of 5" or "/ 5"
    /([1-5]\.\d)\s*(?:out of|\/)\s*5/,
    // Score in a data attribute
    /data-(?:rating|score)="([1-5]\.\d)"/,
  ];

  for (const pattern of ratingPatterns) {
    const match = vicinity.match(pattern);
    if (match) {
      const ratingValue = parseFloat(match[1]);
      if (ratingValue >= 1.0 && ratingValue <= 5.0) {
        return { ratingValue, ratingCount };
      }
    }
  }

  return null;
}

/**
 * Decide whether to retry a show page fetch via the shared scraper fallback
 * chain (Playwright -> Bright Data -> ScrapingBee).
 *
 * BRO-547: GitHub Actions CI gets bot-blocked by Broadway.com in a way that
 * doesn't always look like an obvious challenge page. Sometimes it's a
 * full-size HTTP 200 response that's simply missing the JSON-LD block, so
 * isBotChallenge()'s short-page/marker heuristics never match and the old
 * `!rating && isBotChallenge(html)` gate skipped the fallback entirely.
 * Retrying is cheap — Playwright is tried first for broadway.com and is
 * free — so retry any time rating extraction failed, not only when
 * isBotChallenge() also matches.
 */
function shouldUseScraperFallback(html, rating) {
  return !rating;
}

module.exports = {
  isBotChallenge,
  extractJsonLdRating,
  extractHtmlRating,
  shouldUseScraperFallback,
};
