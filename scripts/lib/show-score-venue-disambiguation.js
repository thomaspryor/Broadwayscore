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

/**
 * Build show-score-candidates.json's next contents (BRO-2595 retro-review).
 * Pure: the caller reads the old file and writes the result.
 *
 * - candidates: this run's (fresh discoveredAt) plus unexpired, unmatched old
 *   ones. A URL this run venue-REJECTED is never carried over: discover-new-shows
 *   auto-consumes `candidates`, so a stale entry would add a show from a listing
 *   the venue check just refused.
 * - outOfScopeUrls: listings observed in the Off-Off-Broadway collection.
 *   They may enrich existing catalog rows, but cannot create new ones. The
 *   collection supplies the tier evidence; URL paths are only identities.
 * - venueRejected: this run's rejects, keeping the first-seen discoveredAt of a
 *   reject already listed, so its age shows how long it has been stuck.
 * - write: false only when there is nothing old or new to record; a file whose
 *   only content is old venueRejected entries is rewritten so they clear.
 *
 * @returns {{ write: boolean, data: object }}
 */
function mergeShowScoreCandidates({ candidates, venueRejects, existing, matchedUrls, outOfScopeUrls = new Set(), ttlDays, now = Date.now() }) {
  const existingCandidates = (existing && existing.candidates) || [];
  const existingRejects = (existing && existing.venueRejected) || [];
  const nowIso = new Date(now).toISOString();
  const currentUrls = new Set(candidates.map(c => c.showScoreUrl));
  const rejectedUrls = new Set(venueRejects.map(v => v.showScoreUrl));
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;

  const merged = [];
  for (const c of candidates) {
    if (outOfScopeUrls.has(c.showScoreUrl)) continue;
    if (matchedUrls.has(c.showScoreUrl)) continue;
    merged.push({ ...c, discoveredAt: nowIso });
  }
  for (const c of existingCandidates) {
    if (outOfScopeUrls.has(c.showScoreUrl)) continue;
    if (currentUrls.has(c.showScoreUrl)) continue;
    if (matchedUrls.has(c.showScoreUrl)) continue;
    if (rejectedUrls.has(c.showScoreUrl)) continue;
    if (now - new Date(c.discoveredAt).getTime() > ttlMs) continue;
    merged.push(c);
  }

  const firstSeen = new Map(existingRejects.filter(v => v && v.showScoreUrl && v.discoveredAt).map(v => [v.showScoreUrl, v.discoveredAt]));
  const venueRejected = venueRejects.map(v => ({ ...v, discoveredAt: firstSeen.get(v.showScoreUrl) || nowIso }));

  const write = merged.length > 0 || existingCandidates.length > 0 || venueRejected.length > 0 || existingRejects.length > 0;
  return {
    write,
    data: {
      _meta: { lastUpdated: nowIso, totalCandidates: merged.length, totalVenueRejected: venueRejected.length, ttlDays },
      candidates: merged,
      // For a person (BRO-2595). discover-new-shows.js consumes only `candidates`.
      venueRejected,
    },
  };
}

module.exports = { disambiguateByVenue, mergeShowScoreCandidates };
