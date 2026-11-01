'use strict';

/**
 * Venues whose own site is the best key-art source for a local production, but that are
 * NOT feeder venues (REGIONAL_FEEDER_VENUES also steers how aggregator candidates are
 * classified, which this must not change). Image sourcing only (BRO-6771).
 */
const { foldDiacritics } = require('./title-match');
const slug = (t) => foldDiacritics(String(t || '')).toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const IMAGE_ONLY_VENUES = [
  {
    re: /\bsignature theat(?:re|er)\b/i, city: 'Arlington, VA', domain: 'sigtheatre.org',
    // Signature files every production under its season (Jul-Jun); a search engine often misses past ones.
    pageUrls: (show) => {
      const d = String(show.openingDate || '');
      const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
      if (!y || !m) return [];
      const start = m >= 7 ? y : y - 1;
      return [`https://www.sigtheatre.org/shows-and-events/all-events/${start}-${start + 1}/${slug(show.title)}`];
    },
    // A missing page still answers with the building photo as og:image: never art for a show.
    genericImage: /Sig_Building/i,
  },
];

function imageOnlyVenue(venue) {
  return IMAGE_ONLY_VENUES.find((v) => v.re.test(venue || '')) || null;
}

module.exports = { IMAGE_ONLY_VENUES, imageOnlyVenue, slug };
