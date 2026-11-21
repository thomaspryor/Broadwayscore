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
    re: /\bsignature theat(?:re|er)\b/i, city: 'Arlington, VA', domain: 'sigtheatre.org', sample: 'Signature Theatre, Arlington, VA',
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
  // Venues behind imageless scored UK/Chicago/DC rows (audit 2026-11-03). Each is a plain
  // "site:<domain> <title>" search: a wrong or dead domain only yields no hit and the generic
  // chain runs as before. Anchored so a bare name cannot capture another venue.
  { re: /^home\b(?:,|\s*$)/i, city: 'Manchester, UK', domain: 'homemcr.org', sample: 'HOME, Manchester' },
  { re: /\boctagon theat(?:re|er)\b/i, city: 'Bolton, UK', domain: 'octagonbolton.co.uk', sample: 'Octagon Theatre, Bolton' },
  { re: /^(?:egg theat(?:re|er)|ustinov)\b/i, city: 'Bath, UK', domain: 'theatreroyal.org.uk', sample: 'Egg Theatre, Bath' },
  { re: /\ba red orchid theat(?:re|er)\b/i, city: 'Chicago, IL', domain: 'aredorchidtheatre.org', sample: 'A Red Orchid Theatre, Chicago, IL' },
  { re: /\bfilament theat(?:re|er)\b/i, city: 'Chicago, IL', domain: 'filamenttheatre.org', sample: 'Filament Theatre, Chicago, IL' },
  { re: /\bfactory theat(?:re|er)\b/i, city: 'Chicago, IL', domain: 'thefactorytheater.com', sample: 'Factory Theater, Chicago, IL' },
  { re: /\btheat(?:re|er) wit\b/i, city: 'Chicago, IL', domain: 'theaterwit.org', sample: 'Theater Wit, Chicago, IL' },
  { re: /\bgreenhouse theat(?:re|er)\b/i, city: 'Chicago, IL', domain: 'greenhousetheater.org', sample: 'The Greenhouse Theater Center, Chicago, IL' },
  // Northlight Theatre plays at The Skokie (North Shore Center).
  { re: /^the skokie\b/i, city: 'Skokie, IL', domain: 'northlight.org', sample: 'The Skokie, Skokie, IL' },
  { re: /\bkeegan theat(?:re|er)\b/i, city: 'Washington, DC', domain: 'keegantheatre.com', sample: 'Keegan Theatre, Washington, DC' },
  { re: /\batlas performing arts\b/i, city: 'Washington, DC', domain: 'atlasarts.org', sample: 'Atlas Performing Arts Center, Washington, DC' },
  { re: /\bsilver spring stage\b/i, city: 'Silver Spring, MD', domain: 'ssstage.org', sample: 'Silver Spring Stage, Silver Spring, MD' },
  // BRO-7265: DC/LA houses whose production page og:image was that production's key art
  // when 36 thumbnail-only/venue-photo rows were sourced by hand (2026-11-19). Not listed:
  // houses whose og:image is a favicon, logo or absent (Woolly Mammoth, Victory, Skylight) or whose producer
  // is a renting company (Atlas, Gunston, El Portal, Madnani).
  { re: /\bolney theat(?:re|er)\b/i, city: 'Olney, MD', domain: 'olneytheatre.org', sample: 'Olney Theatre Center, Olney, MD' },
  { re: /\bround house theat(?:re|er)\b/i, city: 'Bethesda, MD', domain: 'roundhousetheatre.org', sample: 'Round House Theatre, Bethesda, MD' },
  { re: /\bgala hispanic theat(?:re|er)\b/i, city: 'Washington, DC', domain: 'galatheatre.org', sample: 'GALA Hispanic Theatre, Washington, DC' },
  { re: /^theat(?:re|er) 40\b/i, city: 'Beverly Hills, CA', domain: 'theatre40.org', sample: 'Theatre 40 at The Reuben Cordova Theatre, Beverly Hills, CA' },
  { re: /\blong beach playhouse\b/i, city: 'Long Beach, CA', domain: 'lbplayhouse.org', sample: 'Long Beach Playhouse, Long Beach, CA' },
  { re: /\bsouth coast repertory\b/i, city: 'Costa Mesa, CA', domain: 'scr.org', sample: 'South Coast Repertory, Costa Mesa, CA' },
  { re: /^the road (?:on magnolia|theat(?:re|er))\b/i, city: 'North Hollywood, CA', domain: 'roadtheatre.org', sample: 'The Road on Magnolia, North Hollywood, CA' },
  { re: /\bnocturne theat(?:re|er)\b/i, city: 'Glendale, CA', domain: 'thenocturnetheatre.com', sample: 'The Nocturne Theater, Glendale, CA' },
  { re: /^antaeus\b/i, city: 'Glendale, CA', domain: 'antaeus.org', sample: 'Antaeus Theater, Glendale, CA' },
];

function imageOnlyVenue(venue) {
  return IMAGE_ONLY_VENUES.find((v) => v.re.test(venue || '')) || null;
}

module.exports = { IMAGE_ONLY_VENUES, imageOnlyVenue, slug };
