'use strict';
/**
 * Theatres that changed name. A review names the house as it was called on
 * press night, and shows.json keeps the name a production opened under, so
 * the two can differ for the same building (BRO-4956: Rent 2026 is listed at
 * the Duke of York's Theatre, renamed the Tom Stoppard Theatre in 2026; the
 * ensemble scoreability check rejected the LondonTheatre1 and Musical Theatre
 * Review reviews as wrong_production for naming the new name).
 *
 * Each entry pairs the names one building has carried. Add a row when a house
 * is renamed; every name in a row is treated as the same venue.
 */
const VENUE_NAME_GROUPS = [
  ["Duke of York's Theatre", 'Tom Stoppard Theatre'],
  ['Sondheim Theatre', "Queen's Theatre"],
  ['Noël Coward Theatre', 'Albery Theatre'],
  ['Harold Pinter Theatre', 'Comedy Theatre'],
  ['James Earl Jones Theatre', 'Cort Theatre'],
  ['Lena Horne Theatre', 'Brooks Atkinson Theatre'],
  ['Stephen Sondheim Theatre', "Henry Miller's Theatre"],
  ['August Wilson Theatre', 'Virginia Theatre'],
];

function _key(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Other names the same building has carried (empty when none are known). */
function otherVenueNames(venue) {
  const k = _key(venue);
  if (!k) return [];
  const group = VENUE_NAME_GROUPS.find((g) => g.some((n) => _key(n) === k));
  return group ? group.filter((n) => _key(n) !== k) : [];
}

module.exports = { VENUE_NAME_GROUPS, otherVenueNames };
