'use strict';

/**
 * Outlet domain-supplement helper.
 *
 * When an aggregator page (BWW Roundup, DTLI show page, Playbill Verdict, etc.)
 * embeds outbound review links, structured extraction (JSON-LD, anchor text,
 * review-item blocks) sometimes misses outlets. This helper walks every outbound
 * <a href> in the HTML, maps each to a known outletId via resolveOutletFromUrl,
 * and returns stub review records for outlets not already represented.
 *
 * Balusters postmortem CLASS 2 (2026-04-21) — 5 outlets on the Balusters BWW RR
 * (TheaterMania, Vulture, Cote Notices, 1MinuteCritic, Theatrely/Joey Sims) were
 * present as href=… but missed by JSON-LD + articleBody parsers. This helper is
 * the reusable fix.
 *
 * Originally shipped inline inside extractBWWRoundupReviews and extractDTLIReviews
 * as "Method 3" blocks. Extracted to this shared helper per ship-check design-review
 * blocker (don't copy a 40-line guard block into N extractors — shared module, one
 * require() per extractor).
 */

const { resolveOutletFromUrl, getOutletDisplayName } = require('./review-normalization');
const { logExclusion } = require('./exclusion-logger');

/**
 * @typedef {Object} SupplementOptions
 * @property {string} html - Aggregator page HTML
 * @property {Array<Object>} reviews - Reviews already extracted (to avoid duplicate outlets)
 * @property {string} showId - Target show id
 * @property {string} [showTitle] - Show title for URL-slug sanity check
 * @property {string} sourceName - Source tag written onto each stub (e.g. 'bww-roundup-domain-supplement')
 * @property {Array<string>} [excludeDomains] - Substrings to skip on the aggregator's own domain (e.g. ['broadwayworld.com'])
 * @property {Function} urlTitleCheck - (url, showTitle) => boolean. e.g. urlOrTitleLooksLikeReview or urlLooksLikeReview
 * @property {Function} [crossShowCheck] - (showId, url) => { matchedTitle } | null
 * @property {Function} [makeStub] - (oid, url) => Object — customize the stub shape per extractor
 */

/**
 * Walk all outbound hrefs and return supplementary stub reviews for outlets
 * not already represented in `reviews`.
 *
 * For each resolved outletId, iterates candidate URLs and picks the FIRST that
 * passes both urlTitleCheck and crossShowCheck. (Ship-check 2026-04-22 caught an
 * order-dependency bug when the original implementation took urls[0] — sidebar
 * links would shadow real reviews.) Logs via logExclusion when no candidate
 * survives.
 *
 * @param {SupplementOptions} opts
 * @returns {{ added: number, newReviews: Array<Object> }}
 */
function supplementOutletsFromAnchors(opts) {
  const {
    html,
    reviews,
    showId,
    showTitle,
    sourceName,
    excludeDomains = [],
    urlTitleCheck,
    crossShowCheck,
    makeStub,
  } = opts;

  if (!html || typeof html !== 'string') return { added: 0, newReviews: [] };
  if (typeof urlTitleCheck !== 'function') {
    throw new Error('supplementOutletsFromAnchors: urlTitleCheck is required');
  }

  const existingOutletIds = new Set(
    (reviews || []).map(r => (r && r.outletId || '').toLowerCase()).filter(Boolean)
  );
  const urlsByResolved = new Map(); // outletId → Set<url>

  for (const m of html.matchAll(/<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>/gi)) {
    const href = m[1];
    if (excludeDomains.some(d => href.includes(d))) continue;
    const resolved = resolveOutletFromUrl(href);
    if (!resolved || !resolved.outletId) continue;
    const oid = resolved.outletId.toLowerCase();
    if (existingOutletIds.has(oid)) continue;
    if (!urlsByResolved.has(oid)) urlsByResolved.set(oid, new Set());
    urlsByResolved.get(oid).add(href);
  }

  const newReviews = [];
  for (const [oid, urls] of urlsByResolved) {
    let chosen = null;
    for (const candidate of urls) {
      if (showTitle && !urlTitleCheck(candidate, showTitle)) continue;
      if (crossShowCheck && crossShowCheck(showId, candidate)) continue;
      chosen = candidate;
      break;
    }
    if (!chosen) {
      const firstUrl = urls.values().next().value;
      logExclusion({
        script: 'gather-reviews',
        showId,
        file: '-',
        reason: 'skippedCrossShowUrl',
        details: {
          url: firstUrl,
          outletId: oid,
          method: sourceName,
          reason: 'no candidate passed title+cross-show guards',
        },
      });
      continue;
    }

    const stub = makeStub
      ? makeStub(oid, chosen)
      : {
          showId,
          outletId: oid,
          outlet: getOutletDisplayName(oid) || oid,
          criticName: 'Unknown',
          url: chosen,
          source: sourceName,
        };
    newReviews.push(stub);
  }

  return { added: newReviews.length, newReviews };
}

module.exports = { supplementOutletsFromAnchors };
