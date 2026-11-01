'use strict';

/**
 * Venues whose own site is the best key-art source for a local production, but that are
 * NOT feeder venues (REGIONAL_FEEDER_VENUES also steers how aggregator candidates are
 * classified, which this must not change). Image sourcing only (BRO-6771).
 */
const IMAGE_ONLY_VENUES = [
  { re: /\bsignature theat(?:re|er)\b/i, city: 'Arlington, VA', domain: 'sigtheatre.org' },
];

function imageOnlyVenue(venue) {
  return IMAGE_ONLY_VENUES.find((v) => v.re.test(venue || '')) || null;
}

module.exports = { IMAGE_ONLY_VENUES, imageOnlyVenue };
