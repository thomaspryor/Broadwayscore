/**
 * Pure false-positive guards for the cross-production attribution heuristic in
 * scripts/audit-cross-production.js. Extracted so the two FP classes that bit us
 * on 2026-06-21 are locked by tests/unit/cross-production-guards.test.mjs
 * (CLAUDE.md rule 15: extract → export → require() in tests).
 *
 * No I/O, no module state.
 */

'use strict';

/**
 * Evergreen / listing / tickets pages are NOT dated critic reviews — their
 * publishDate is a re-scrape/listing timestamp, so the date-proximity heuristic
 * mis-fires and points the review at whichever production happens to be opening
 * near the scrape date. (e.g. britishtheatre.com/.../titanique-musical-tickets
 * scraped 2026 → mis-attributed to the 2026 Broadway run while the text plainly
 * describes the West End Criterion staging it is correctly filed under.)
 *
 * @param {string|null|undefined} url
 * @returns {boolean}
 */
function isEvergreenListingUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    /(?:^|[\/-])tickets(?:[\/?#-]|$)/.test(u) ||  // .../titanique-musical-tickets, /tickets/
    /\/buy-tickets?\b/.test(u) ||
    /\/box-office\b/.test(u) ||
    /\/whats-on\//.test(u) ||
    /\/listings?\//.test(u) ||                     // nymag.com/listings/theater/...
    /\/shows?\/[^\/?#]*-tickets\b/.test(u)
  );
}

/**
 * True when the review BODY clearly names the venue of the production it is
 * filed under. When the prose says "...sails into the Criterion Theatre..." and
 * that IS the filed-under production's venue, the review is correctly filed
 * regardless of any date-proximity to another production.
 *
 * CRITICAL: matches `review.fullText` ONLY — never `review.venue`. The venue
 * metadata field is auto-populated from the filed-under show at ingestion, so
 * including it makes this a tautology that suppresses EVERY review with a venue
 * field — including genuine cross-production misfiles whose body never mentions
 * the venue (2026-06-21: 2019 NY Post Broadway reviews misfiled under
 * beetlejuice-west-end-2026 carry venue="Prince Edward Theatre" but their bodies
 * don't). The test suite asserts this body-only contract.
 *
 * @param {object} review - parsed review-text JSON (uses fullText only)
 * @param {string|null} ownVenueSlug - venueSlug(prod.venue)
 * @returns {boolean}
 */
function contentMatchesFiledUnderVenue(review, ownVenueSlug) {
  if (!ownVenueSlug) return false;
  const hay = String((review && review.fullText) || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return hay.includes(ownVenueSlug);
}

module.exports = { isEvergreenListingUrl, contentMatchesFiledUnderVenue };
