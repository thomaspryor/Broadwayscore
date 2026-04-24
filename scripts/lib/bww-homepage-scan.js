/**
 * BWW homepage scan — find a show's Review Roundup link among the homepage anchors.
 *
 * On opening night BWW features the latest roundup prominently on its homepage BEFORE
 * Google has indexed the article URL, so direct homepage scraping beats SERP for
 * same-day discovery. This module extracts every Review-Roundup anchor from the
 * supplied HTML and picks the one whose slug matches the show title, reusing the
 * shared BWW slug validator (short-title fallback + tryout rejection baked in).
 *
 * Rocky Horror 2026-04-23 opening night: poller logged "No matching roundup link
 * found on BWW homepage" while a literal href to the correct roundup article was
 * present — this module replaces the inline ad-hoc matcher that caused the miss.
 */

const { validateBWWRoundupUrlMatchesShow } = require('./bww-roundup-validator');

/**
 * Extract every Review-Roundup anchor on a BWW homepage-style HTML payload.
 * Handles both absolute (https://...) and protocol-relative (//...) hrefs,
 * single- or double-quoted attributes, and decodes HTML-escaped ampersands.
 */
function extractRoundupAnchors(html) {
  if (!html || typeof html !== 'string') return [];
  const found = new Set();
  const patterns = [
    // Absolute URLs: https://www.broadwayworld.com/[london/]article/Review-Roundup-...
    /href=["'](https?:\/\/(?:www\.)?broadwayworld\.com\/(?:london\/)?article\/Review-Roundup[^"']*)["']/gi,
    // Protocol-relative: //www.broadwayworld.com/article/Review-Roundup-...
    /href=["'](\/\/(?:www\.)?broadwayworld\.com\/(?:london\/)?article\/Review-Roundup[^"']*)["']/gi,
    // Root-relative: /article/Review-Roundup-... or /london/article/Review-Roundup-...
    /href=["'](\/(?:london\/)?article\/Review-Roundup[^"']*)["']/gi,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(html)) !== null) {
      let url = m[1].replace(/&amp;/g, '&');
      if (url.startsWith('//')) url = 'https:' + url;
      else if (url.startsWith('/')) url = 'https://www.broadwayworld.com' + url;
      found.add(url);
    }
  }
  return [...found];
}

/**
 * Find the Review-Roundup URL on `html` whose slug matches `showTitle`.
 * Returns the URL string or null. Short-title fallback + tryout rejection
 * come from the shared validator — this function is the discovery/iteration layer.
 *
 * If anchors are present but none match, logs a one-line diagnostic with the
 * candidate count + a sample slug so the next opening-night session doesn't have
 * to reconstruct what the homepage had offered.
 */
function findBWWRoundupLinkOnHomepage(html, showTitle, { logger = console } = {}) {
  const urls = extractRoundupAnchors(html);
  if (urls.length === 0) return null;
  if (!showTitle) return null;

  for (const url of urls) {
    if (validateBWWRoundupUrlMatchesShow(url, showTitle)) return url;
  }

  const sample = urls.slice(0, 3).map(u => {
    const m = u.match(/Review-Roundup-([^/?#]+)/i);
    return m ? m[1].slice(0, 60) : u.slice(-60);
  });
  logger.log(`    BWW homepage had ${urls.length} Review-Roundup anchor(s) but none matched "${showTitle}". Sample: ${JSON.stringify(sample)}`);
  return null;
}

module.exports = { findBWWRoundupLinkOnHomepage, extractRoundupAnchors };
