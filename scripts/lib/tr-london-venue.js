'use strict';

/**
 * Is a Theatre Record search-result venue a London house? Moved out of
 * extract-theatre-record.js (which runs main() on require) so the WE
 * historical review-led resolver (BRO-5031) shares it. Rejects same-named
 * houses in other cities ("Royal Lyceum Theatre, Edinburgh").
 */

// WE venue name patterns that indicate the right production
// ONLY includes unambiguous London venues — names like "playhouse", "palace",
// "lyceum", "cambridge", "phoenix" exist in Edinburgh/regional cities
const LONDON_VENUES = [
  'west end', 'london', 'victoria palace', 'apollo victoria',
  'savoy', 'dominion', 'drury lane', 'gielgud', 'wyndham', 'garrick',
  'noel coward', 'harold pinter', 'duke of york', 'criterion', 'novello',
  'adelphi', 'prince edward', 'prince of wales',
  'sondheim', 'gillian lynne', 'troubadour', 'kit kat club',
  "st martin", "her majesty", "his majesty", 'old vic', 'young vic',
  'national theatre', 'donmar', 'almeida', 'dorfman', 'olivier', 'lyttelton',
  'barbican', 'sadler', 'ambassadors', 'piccadilly', 'vaudeville',
  'fortune', 'duchess', 'trafalgar',
];

// Cities that indicate NOT London (used to reject ambiguous venue names)
const NON_LONDON_CITIES = [
  'edinburgh', 'bristol', 'birmingham', 'manchester', 'leeds', 'cardiff',
  'glasgow', 'sheffield', 'nottingham', 'southampton', 'brighton', 'bath',
  'chichester', 'oxford', 'salford', 'milton keynes', 'newcastle',
  'liverpool', 'plymouth', 'norwich', 'canterbury',
];

const PDF_ERA_BARE_LONDON = /^(?:royal court|theatre upstairs|arts|apollo|phoenix|playhouse|lyceum|palace|cambridge|aldwych|lyric|shaftesbury|queen's|theatre royal - haymarket)$/;

function isLondonVenue(venueText, { pdfEra = false } = {}) {
  if (!venueText) return false;
  const lower = venueText.toLowerCase();
  // Reject if a non-London city is mentioned
  if (NON_LONDON_CITIES.some(city => lower.includes(city))) return false;
  // PDF-era TR omits London on its own houses and suffixes the city on
  // regional ones ("Playhouse - Edinburgh", "Apollo - Hammersmith"). Accept
  // only these exact bare names, and only with explicit PDF context (BRO-5851).
  if (pdfEra && PDF_ERA_BARE_LONDON.test(lower.trim())) return true;
  return LONDON_VENUES.some(v => lower.includes(v));
}

module.exports = { LONDON_VENUES, NON_LONDON_CITIES, isLondonVenue };
