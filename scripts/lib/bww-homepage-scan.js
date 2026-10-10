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

// Silent logger for callers that don't want diagnostic output in stdout. Default for
// findBWWRoundupLinkOnHomepage — gather-reviews.js passes `console` when it wants the
// opening-night diagnostic line to land in workflow logs.
const NOOP_LOGGER = { log: () => {} };

/**
 * Extract every Review-Roundup anchor on a BWW homepage-style HTML payload.
 * Handles both absolute (https://...) and protocol-relative (//...) hrefs,
 * single- or double-quoted attributes, and decodes HTML-escaped ampersands.
 *
 * Also accepts lazy-load `data-href` / `data-url` attributes (no real callers today,
 * but P2 card noted: if BWW switches to lazy-loaded teaser cards, href-only detection
 * would silently return zero anchors without any error).
 */
function extractRoundupAnchors(html) {
  if (!html || typeof html !== 'string') return [];
  const found = new Set();
  const patterns = [
    // Absolute URLs: https://www.broadwayworld.com/[london/]article/Review-Roundup-...
    /(?:href|data-href|data-url)=["'](https?:\/\/(?:www\.)?broadwayworld\.com\/(?:london\/)?article\/Review-Roundup[^"']*)["']/gi,
    // Protocol-relative: //www.broadwayworld.com/article/Review-Roundup-...
    /(?:href|data-href|data-url)=["'](\/\/(?:www\.)?broadwayworld\.com\/(?:london\/)?article\/Review-Roundup[^"']*)["']/gi,
    // Root-relative: /article/Review-Roundup-... or /london/article/Review-Roundup-...
    /(?:href|data-href|data-url)=["'](\/(?:london\/)?article\/Review-Roundup[^"']*)["']/gi,
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
 * to reconstruct what the homepage had offered. Default logger is silent; callers
 * that want the diagnostic (gather-reviews.js during a poller run) pass `console`.
 *
 * Validator failures inside the loop are caught and logged — a regex regression in
 * a future bww-roundup-validator edit shouldn't be able to abort a whole
 * gather-reviews run for every show on the homepage.
 */
function findBWWRoundupLinkOnHomepage(html, showTitle, { logger = NOOP_LOGGER } = {}) {
  const urls = extractRoundupAnchors(html);
  if (urls.length === 0) return null;
  if (!showTitle) return null;

  for (const url of urls) {
    try {
      if (validateBWWRoundupUrlMatchesShow(url, showTitle)) return url;
    } catch (e) {
      logger.log(`    BWW homepage scan: validator threw on "${url}" — ${e && e.message ? e.message : e}. Continuing.`);
    }
  }

  const sample = urls.slice(0, 3).map(u => {
    const m = u.match(/Review-Roundup-([^/?#]+)/i);
    return m ? m[1].slice(0, 60) : u.slice(-60);
  });
  logger.log(`    BWW homepage had ${urls.length} Review-Roundup anchor(s) but none matched "${showTitle}". Sample: ${JSON.stringify(sample)}`);
  return null;
}

module.exports = { findBWWRoundupLinkOnHomepage, extractRoundupAnchors };
