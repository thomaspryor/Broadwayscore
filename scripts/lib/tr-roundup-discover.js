/**
 * theatre.reviews roundup discovery (WE/OWE).
 *
 * Extracted verbatim from opening-night-poller.js block 1e (2026-07-10) so the
 * same discovery chain — bounded URL construction → WP-API search, both gated
 * by verifyAggregatorUrl's cross-show guard — is callable by both the poller
 * and the review-gap audit. Per the repo's per-source discovery-lib convention.
 *
 * Returns the validated roundup HTML; PARSING stays in
 * scrape-theatre-reviews.js (extractReviews).
 *
 * Discovery chain (REVIEWED 2026-05-16, Notion 362637c5-416f-8109: TR has no
 * listing-page equivalent of BWW's /reviews.php — bounded construction is the
 * best available primitive, validated per candidate; NOT the BWW antipattern):
 *   1. https://theatre.reviews/reviews-roundup/{title-slug}[-{venue-slug}]-reviews/
 *      — must contain ⭑ ratings + a title word + pass verifyAggregatorUrl
 *      (war horse → equus-menier contamination class)
 *   2. WP-API search /wp-json/wp/v2/posts?search= — first /reviews-roundup/
 *      link, same verifyAggregatorUrl gate
 *
 * @param {object} show - shows.json record ({ id, title, venue, openingDate })
 * @param {object} [opts]
 * @param {Function} [opts.fetchPage] Injected for tests
 * @param {Function} [opts.fetchJSON] Injected for tests
 * @param {Function} [opts.log]       Logger (default console.log)
 * @returns {Promise<{html: string, url: string}|null>}
 */

const { verifyAggregatorUrl } = require('./show-match-verifier');
const { cleanSearchTitle } = require('./title-normalization');

async function discoverTrRoundupHtml(show, opts = {}) {
  const fetchPage = opts.fetchPage || require('./scraper').fetchPage;
  const fetchJSON = opts.fetchJSON || require('./scraper').fetchJSON;
  const log = opts.log || console.log;

  const titleSlug = show.title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const trUrls = [
    `https://theatre.reviews/reviews-roundup/${titleSlug}-reviews/`,
  ];
  // Also try with venue suffix if we have venue info
  if (show.venue) {
    const venueSlug = show.venue.toLowerCase()
      .replace(/\s*theatre\s*/gi, '').replace(/\s*theater\s*/gi, '')
      .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    if (venueSlug) {
      trUrls.unshift(`https://theatre.reviews/reviews-roundup/${titleSlug}-${venueSlug}-reviews/`);
    }
  }

  // 1. Direct URL construction via proxy (avoids TLS fingerprint blocking in CI)
  for (const trUrl of trUrls) {
    try {
      const result = await fetchPage(trUrl, { renderJs: false });
      // Content must be the actual roundup page — ⭑ star ratings AND a key
      // title word (not just generic site chrome)
      const titleWord = show.title.split(/\s+/).filter(w => w.length > 3)[0] || show.title;
      if (result && result.content && result.content.length > 1000 &&
          result.content.includes('⭑') &&
          result.content.toLowerCase().includes(titleWord.toLowerCase())) {
        const v = verifyAggregatorUrl({ url: trUrl, html: result.content, show, openingDate: show.openingDate });
        if (!v.isValid) {
          log(`    ✗ TR ${trUrl} rejected: ${v.rejectReason} (cross-show guard)`);
          continue;
        }
        log(`    Found at: ${trUrl} (via ${result.source})`);
        return { html: result.content, url: trUrl };
      }
    } catch (e) {
      // 404/403 are expected for guessed URLs — continue to next variation
    }
  }

  // 2. Fallback: WP API search when URL construction misses
  try {
    const searchTitle = cleanSearchTitle(show.title);
    const wpApiUrl = `https://theatre.reviews/wp-json/wp/v2/posts?per_page=5&search=${encodeURIComponent(searchTitle)}`;
    const posts = await fetchJSON(wpApiUrl);
    if (posts && Array.isArray(posts)) {
      const roundup = posts.find(p => p.link && p.link.includes('/reviews-roundup/'));
      if (roundup) {
        log(`    WP API found: ${roundup.link}`);
        const pageResult = await fetchPage(roundup.link, { renderJs: false });
        if (pageResult && pageResult.content && pageResult.content.length > 1000) {
          const v = verifyAggregatorUrl({ url: roundup.link, html: pageResult.content, show, openingDate: show.openingDate });
          if (v.isValid) {
            return { html: pageResult.content, url: roundup.link };
          }
          log(`    ✗ TR WP-API ${roundup.link} rejected: ${v.rejectReason} (cross-show guard)`);
        }
      }
    }
  } catch (e) {
    log(`    TR WP API fallback error: ${(e.message || '').substring(0, 60)}`);
  }

  return null;
}

module.exports = { discoverTrRoundupHtml };
