/**
 * Pure false-positive guards for the cross-production attribution heuristic in
 * scripts/audit-cross-production.js. Extracted so the two FP classes that bit us
 * on 2026-06-21 are locked by tests/unit/cross-production-guards.test.mjs
 * (CLAUDE.md rule 15: extract → export → require() in tests).
 *
 * No I/O, no module state.
 */

'use strict';

const { foldDiacritics } = require('./title-match');

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
  // Singular whole-word review/reviewed in the PATH means a headline slug that merely
  // contains "tickets" (express.co.uk ...-musical-review-...-dates-tickets, radiotimes
  // /going-out/tickets/hercules-musical-review/, BRO-5876). Plain "reviews" is NOT
  // exempt: "avenue-q-reviews-tickets" / "tickets-reviews-and-video" are roundup/show pages.
  const path = u.replace(/^https?:\/\/[^\/]+/, '').replace(/[?#].*$/, '');
  // An outlet's /reviews/ section counts too when "tickets" is only a slug word
  // (independent.co.uk/.../theatre-dance/reviews/im-not-running-...-cast-tickets-
  // last-night-...). A /tickets/ path segment never gets this exemption
  // (/reviews/tickets/ is a hub page), and a plural "reviews" inside the slug
  // still does not count.
  const pathSaysReview = /(^|[^a-z])review(ed)?([^a-z]|$)/.test(path)
    || (/\/reviews\/[^\/]+/.test(path) && !/\/tickets(\/|$)/.test(path));
  return (
    (!pathSaysReview && /(?:^|[\/-])tickets(?:[\/?#-]|$)/.test(u)) ||  // .../titanique-musical-tickets, /tickets/
    /\/buy-tickets?\b/.test(u) ||
    /\/box-office\b/.test(u) ||
    // /whats-on/ is a venue listing unless the path says "review" as a whole word
    // (londonmumsmagazine.com/whats-on/review-holy-fool-..., BRO-2854); same rule
    // as isBlockedUrl in domain-filters.js.
    (/\/whats-on\//.test(u) && !/(^|[^a-z])review(s|ed)?([^a-z]|$)/.test(u.replace(/^https?:\/\/[^\/]+/, '').replace(/[?#].*$/, ''))) ||
    /\/listings?\//.test(u) ||                     // nymag.com/listings/theater/...
    /\/shows?\/[^\/?#]*-tickets\b/.test(u) ||
    // westendtheatre.com show pages (/56719/shows/dinosaur-world-live/) are venue/
    // booking listings, not reviews — the -tickets suffix is inconsistent, so match
    // the numeric-id /shows/ path shape directly (2026-08-04: three WET listing
    // pages ingested as unflagged "reviews" on NYSM/Dinosaur World/Crocodile).
    /westendtheatre\.com\/\d+\/shows?\//.test(u)
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
 * @param {string|null} ownVenueSlug - venue-classification.js's venueSlug(prod.venue)
 * @returns {boolean}
 */
// foldDiacritics BEFORE the ASCII strip — `hay` must stay byte-for-byte paired
// with the encoding venue-classification.js's venueSlug() now produces (task
// #783: previously two separately-duplicated, UNFOLDED copies of venueSlug()
// lived in scripts/audit-cross-production.js and scripts/audit-review-url-
// clusters.js; both now import the single folded helper this fold matches).
function contentMatchesFiledUnderVenue(review, ownVenueSlug) {
  if (!ownVenueSlug) return false;
  const hay = foldDiacritics(String((review && review.fullText) || ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return hay.includes(ownVenueSlug);
}

module.exports = { isEvergreenListingUrl, contentMatchesFiledUnderVenue };
