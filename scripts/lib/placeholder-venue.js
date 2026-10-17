/**
 * Placeholder-venue predicate — the ONE definition of "this `venue` value is
 * not a venue" (S4-T7, 2026 data audit BRO-4204).
 *
 * History: `isPlaceholderVenue` / `UNKNOWN_MARKERS` were born in
 * scripts/audit-placeholder-venues.js (#987, S0-T1) and were then COPIED into
 * scripts/lib/venue-write-guard-detector.js (card #1923's source lint) so the
 * lint could reject a hand-typed `venue: "TBA"` literal. Two copies drifted:
 * the write-time guard (sanitizeVenueForWrite, scripts/lib/venue-
 * classification.js) rejected "Off-Broadway" via NEIGHBOURHOOD_BLOBS while
 * the lint's marker set did not know it, and neither knew "West End" — which
 * is how a West End show landed in shows.json with `venue: "West End"` (a
 * market, not a house). All three consumers now require() this module, and
 * the lint calls the same predicate the guard does, so they cannot disagree.
 *
 * Pure: no fs, no data, no side effects at load — safe to require() from a
 * lib, a CLI or a test (CLAUDE.md §15).
 */

/**
 * Neighbourhood / region strings that have been observed stored in the `venue`
 * field. These are NOT venues — they are the granularity above a venue, and a
 * show carrying one tells us nothing about which house it plays.
 *
 * Exact-match (after trim) rather than substring: "West Village Musical Theatre
 * Festival" is a real venue name containing "West Village", and must pass.
 */
const NEIGHBOURHOOD_BLOBS = new Set([
  'midtown e',
  'midtown w',
  'midtown east',
  'midtown west',
  'greenwich v',
  'greenwich village',
  'soho/tribeca',
  'soho / tribeca',
  'east village',
  'west village',
  'upper w side',
  'upper e side',
  'brooklyn',
  'queens',
  'harlem',
]);

/**
 * Values meaning "we do not know the venue". Compared case-insensitively
 * against the WHOLE trimmed string, never as a substring — "West End Theatre"
 * (a real Off-Broadway house on W 86th) and "Various Artists Studio" must
 * still pass.
 *
 * 'west end' / 'off-broadway' / 'various' (S4-T7): market labels and "it
 * moves around" are the same class as TBA — a scraper or an LLM filling the
 * venue slot with the market it already knew. 'off-broadway' moved here from
 * NEIGHBOURHOOD_BLOBS so the lint (which only ever knew UNKNOWN_MARKERS) and
 * the write-time guard finally agree on it.
 */
const UNKNOWN_MARKERS = new Set([
  'tba', 'tbd', 'n/a', 'na', 'unknown', '', '-',
  'west end', 'off-broadway', 'various',
]);

/**
 * Substrings that only ever appear in junk written to the venue field —
 * scraped instructions rather than a name.
 */
const JUNK_SUBSTRINGS = [
  'confirmation email',
  'check your',
  'see website',
  'various locations',
  'multiple venues',
  'lorem ipsum',
];

/**
 * Is this `venue` value a placeholder rather than a real venue?
 *
 * Fails CLOSED for the caller's benefit: a missing/blank venue counts as a
 * placeholder, because the whole point is "we cannot classify this show yet".
 *
 * @param {string|null|undefined} venue
 * @returns {{ placeholder: boolean, reason: string|null }}
 */
function isPlaceholderVenue(venue) {
  if (venue === null || venue === undefined) return { placeholder: true, reason: 'missing' };
  if (typeof venue !== 'string') return { placeholder: true, reason: 'not_a_string' };

  const trimmed = venue.trim();
  const lower = trimmed.toLowerCase();

  if (UNKNOWN_MARKERS.has(lower)) return { placeholder: true, reason: 'unknown_marker' };
  if (NEIGHBOURHOOD_BLOBS.has(lower)) return { placeholder: true, reason: 'neighbourhood_blob' };
  for (const j of JUNK_SUBSTRINGS) {
    if (lower.includes(j)) return { placeholder: true, reason: 'junk_text' };
  }
  // A bare postcode/number, or a single character, is not a venue name.
  if (trimmed.length < 3) return { placeholder: true, reason: 'too_short' };
  // A digits-only string ("123") passed the length check above but is still
  // not a venue name — a bare street number or postcode fragment slipping
  // through unrelated parsing, not a theatre (ship-check finding, card #1922
  // follow-up: sanitizeVenueForWrite previously let "123" through as valid).
  if (/^\d+$/.test(trimmed)) return { placeholder: true, reason: 'numeric_only' };

  return { placeholder: false, reason: null };
}

module.exports = { isPlaceholderVenue, NEIGHBOURHOOD_BLOBS, UNKNOWN_MARKERS, JUNK_SUBSTRINGS };
