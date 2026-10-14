/**
 * Venue step of discover-show-score-urls-from-listings.js's findBestMatch
 * (BRO-2595). When a Show Score listing's title matches 2+ productions and
 * the listing names a venue ("Hamlet (Park Avenue Armory)"), keep only the
 * productions at that venue.
 *
 * It used to fall back to the FULL candidate set when no production matched
 * the venue, then pick one by status/date, so any Show Score venue spelling
 * venuesMatch() does not model could attach a URL to the wrong production.
 * A named venue that matches none of them now rejects the listing instead.
 * Productions with no venue on file cannot be ruled out, so when some exist
 * they are what remains rather than a rejection.
 *
 * @param {object[]} candidates shows.json rows already narrowed by title and market
 * @param {string|null} listingVenue venue parsed from the listing title, or null
 * @param {(a: string, b: string) => boolean} venuesMatch deduplication.js venuesMatch
 * @returns {{ candidates: object[], rejected: boolean }}
 */
function disambiguateByVenue(candidates, listingVenue, venuesMatch) {
  if (!listingVenue || candidates.length <= 1) return { candidates, rejected: false };
  const atVenue = candidates.filter(s => s.venue && venuesMatch(listingVenue, s.venue));
  if (atVenue.length > 0) return { candidates: atVenue, rejected: false };
  const noVenue = candidates.filter(s => !s.venue);
  if (noVenue.length > 0) return { candidates: noVenue, rejected: false };
  return { candidates: [], rejected: true };
}

module.exports = { disambiguateByVenue };
