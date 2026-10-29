'use strict';
/**
 * Venue -> metro slug for regional city hubs (BRO-6515; UK BRO-6516, US BRO-6498).
 *
 * One table, data/venue-metros.json. `market` stays 'regional'/'tour' (it
 * drives the fail-closed gates); `city` on a show is the metro slug this
 * returns. Resolution order:
 *   1. a venue alias (longest first, word-bounded after normalising case,
 *      accents, apostrophes and punctuation);
 *   2. the venue string's trailing place ("..., Evanston, IL" or "..., Leeds")
 *      looked up in the table's `places`;
 *   3. US/Canada only: a trailing "City, ST" slugged like
 *      src/lib/tour-cities.ts citySlug, so a hub slug equals its /tours/[city]
 *      slug ("Chicago, IL" -> chicago-il).
 * A UK venue with no alias or listed place returns null: there is no state
 * code to make a generic suffix safe.
 */
const TABLE = require('../../data/venue-metros.json');

const CA_PROVINCES = new Set(['ON', 'BC', 'QC', 'AB', 'MB', 'NS', 'NB', 'NL', 'PE', 'SK']);
const US_STATES = new Set(('AL AK AZ AR CA CO CT DC DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' '));

function norm(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Same rule as src/lib/tour-cities.ts citySlug. */
function citySlug(city) {
  return String(city || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// A one-word display name ("HOME", "Curve") is too generic to match bare; only
// its explicit aliases ("home, manchester") count.
const ALIASES = TABLE.venues
  .flatMap((v) => [...(norm(v.venue).includes(' ') ? [v.venue] : []), ...(v.aliases || [])]
    .map((a) => ({ key: norm(a), metro: v.metro })))
  .filter((a) => a.key.length >= 4)
  .sort((a, b) => b.key.length - a.key.length);

const PLACES = new Map(Object.entries(TABLE.places).map(([p, m]) => [norm(p), m]));

function metroInfo(slug, fallbackName, fallbackCountry) {
  const m = TABLE.metros[slug];
  if (m) return { slug, name: m.name, country: m.country, hub: m.hub || null };
  return { slug, name: fallbackName, country: fallbackCountry, hub: null };
}

/** { slug, name, country, hub } for a venue string, or null when unmapped. */
function resolveMetroInfo(venue) {
  const v = norm(venue);
  if (!v) return null;
  const padded = ` ${v} `;
  const hit = ALIASES.find((a) => padded.includes(` ${a.key} `));
  if (hit) return metroInfo(hit.metro);

  const parts = String(venue).split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const two = parts.slice(-2).join(', ');
    const m2 = PLACES.get(norm(two));
    if (m2) return metroInfo(m2);
  }
  if (parts.length >= 2) {
    const m1 = PLACES.get(norm(parts[parts.length - 1]));
    if (m1) return metroInfo(m1);
  }
  if (parts.length >= 3) {
    const st = parts[parts.length - 1].replace(/\./g, '').toUpperCase();
    const city = parts[parts.length - 2];
    const country = CA_PROVINCES.has(st) ? 'CA' : US_STATES.has(st) ? 'US' : null;
    if (country && /^[A-Za-z][A-Za-z .'-]*$/.test(city)) {
      const slug = citySlug(`${city}, ${st}`);
      return metroInfo(slug, city, country);
    }
  }
  return null;
}

/** Metro slug ('manchester-uk', 'chicago-il') for a venue string, or null. */
function resolveMetro(venue) {
  const info = resolveMetroInfo(venue);
  return info ? info.slug : null;
}

/** Metro slugs grouped under a hub key from the table ('yorkshire' -> leeds-uk, ...). */
function hubMetros(hub) {
  return Object.entries(TABLE.metros).filter(([, m]) => m.hub === hub).map(([slug]) => slug);
}

module.exports = { resolveMetro, resolveMetroInfo, hubMetros, citySlug, norm, TABLE };
