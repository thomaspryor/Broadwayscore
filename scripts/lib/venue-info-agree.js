'use strict';
const { foldDiacritics } = require('./url-slug');
/**
 * venue-info-agree.js — decide which venue facts two independent sources agree on (BRO-8088).
 *
 * Off-Broadway and London venue pages had no address, website or capacity: the
 * "coming soon" enrichment was never carded. scripts/research-venue-details.js asks two
 * web-searching models (Gemini grounded + OpenAI web search) for each venue
 * independently; a fact is published ONLY when both answers agree under the rules
 * here. Disagreement means the field stays blank, never a guess.
 *
 * Pure functions, no I/O, so the rules are unit-tested (scripts/test-venue-info.js).
 */

const ORDINALS = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th' };
const STREET_WORDS = {
  street: 'st', st: 'st', avenue: 'ave', ave: 'ave', av: 'ave', road: 'rd', rd: 'rd', place: 'pl', pl: 'pl',
  lane: 'ln', ln: 'ln', square: 'sq', sq: 'sq', boulevard: 'blvd', blvd: 'blvd', drive: 'dr', dr: 'dr',
  court: 'ct', ct: 'ct', terrace: 'ter', ter: 'ter', way: 'way', row: 'row', walk: 'walk', yard: 'yard',
  west: 'w', w: 'w', east: 'e', e: 'e', north: 'n', n: 'n', south: 's', s: 's',
};
// Words that never decide whether two addresses are the same place.
const NOISE = new Set(['the', 'of', 'and', 'new', 'york', 'ny', 'nyc', 'manhattan', 'brooklyn', 'queens', 'bronx',
  'london', 'uk', 'united', 'kingdom', 'england', 'usa', 'us', 'greater', 'city', 'westminster']);

function tokens(s) {
  return foldDiacritics(String(s || ''))
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** UK postcode (full) or US ZIP, uppercased without spaces; null when absent. */
function postcodeOf(addr) {
  const s = String(addr || '').toUpperCase();
  const uk = s.match(/\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/);
  if (uk) return uk[1] + uk[2];
  const us = s.match(/\b(\d{5})(?:-\d{4})?\b\s*$/) || s.match(/\bN\.?Y\.?\s+(\d{5})\b/);
  return us ? us[1] : null;
}

/**
 * The street line reduced to {number, street} — "302 West 45th Street, New York, NY" →
 * {number:'302', street:'w 45th st'}. Ranges keep their first number ("2-4" → "2").
 */
function streetKey(addr) {
  const first = String(addr || '').split(',')[0];
  const t = tokens(first).map((w) => ORDINALS[w] || STREET_WORDS[w] || w);
  const numIdx = t.findIndex((w) => /^\d+[a-z]?$/.test(w) && !/^\d+(st|nd|rd|th)$/.test(w));
  const number = numIdx >= 0 ? t[numIdx].replace(/[a-z]$/, '') : null;
  // Later house numbers in a range ("1a/1b", "10-12") are not street words (BRO-8173: Almeida).
  const rest = (numIdx >= 0 ? t.slice(numIdx + 1) : t).filter((w) => !/^\d+[a-z]?$/.test(w) && !NOISE.has(w));
  return { number, street: rest.join(' ') };
}

/**
 * Two addresses agree when they name the same street and house number. For London,
 * where many theatres have no house number, an exact full-postcode match plus an
 * overlapping street word also counts.
 */
function addressesAgree(a, b) {
  if (!a || !b) return false;
  const ka = streetKey(a);
  const kb = streetKey(b);
  const pa = postcodeOf(a);
  const pb = postcodeOf(b);
  // Different full postcodes (or ZIPs) = different places.
  if (pa && pb && pa !== pb) return false;
  if (ka.number && kb.number) {
    return ka.number === kb.number && ka.street !== '' && ka.street === kb.street;
  }
  if (pa && pb && pa === pb && /[A-Z]/.test(pa)) {
    const wa = new Set(ka.street.split(' ').filter((w) => w.length > 2));
    return kb.street.split(' ').some((w) => w.length > 2 && wa.has(w));
  }
  return false;
}

/** Registrable host: "https://www.theplayerstheatre.com/about" → "theplayerstheatre.com". */
function siteHost(url) {
  try {
    const h = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    return h.replace(/^www\d?\./, '');
  } catch {
    return null;
  }
}

function siteUrl(u) {
  return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
}

/**
 * The agreed website. Both sources often point at the venue's own page on a group or
 * operator site (lwtheatres.co.uk/theatres/adelphi); keep that path when they agree on it,
 * otherwise fall back to the shared host's homepage.
 */
function pickWebsite(a, b) {
  try {
    const ua = siteUrl(a);
    const ub = siteUrl(b);
    const pa = ua.pathname.replace(/\/+$/, '').toLowerCase();
    const pb = ub.pathname.replace(/\/+$/, '').toLowerCase();
    // Prefer https when either source gave it (both agree on the host).
    const origin = ua.protocol === 'https:' || ub.protocol === 'https:' ? `https://${ua.host}` : ua.origin;
    if (pa && pa === pb) return `${origin}${ua.pathname.replace(/\/+$/, '')}`;
    return `${origin}/`;
  } catch {
    return null;
  }
}

function websitesAgree(a, b) {
  const ha = siteHost(a);
  const hb = siteHost(b);
  return !!ha && ha === hb;
}

/** Capacity counts agree only when they are within 2 seats (house layouts differ by config). */
function capacitiesAgree(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 10 || y < 10 || x > 5000 || y > 5000) return false;
  return Math.abs(x - y) <= 2;
}

function yearsAgree(a, b) {
  const x = Number(a);
  const y = Number(b);
  return Number.isInteger(x) && x === y && x >= 1600 && x <= new Date().getFullYear() + 1;
}

const ORG_NOISE = new Set(['the', 'inc', 'llc', 'ltd', 'limited', 'company', 'co', 'trust', 'group', 'and', 'of', 'theatre', 'theater', 'productions', 'organisation', 'organization']);
function orgTokens(s) {
  return tokens(s).filter((w) => !ORG_NOISE.has(w));
}

/** Operators agree when the shorter name's significant words all appear in the longer one. */
function operatorsAgree(a, b) {
  const ta = orgTokens(a);
  const tb = orgTokens(b);
  if (!ta.length || !tb.length) return false;
  const [short, long] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return short.every((w) => long.has(w));
}

/**
 * Merge two independent answers into the published record. Each answer is
 * {exists, address, website, capacity, yearOpened, operator, sources[]}.
 * Returns {fields, disagreements} — fields hold only agreed values.
 */
function agree(g, o) {
  const fields = {};
  const disagreements = [];
  if (!g || !o || g.exists === false || o.exists === false) {
    return { fields, disagreements: g && o && g.exists !== o.exists ? [{ field: 'exists', gemini: g.exists, openai: o.exists }] : [] };
  }
  const check = (field, test, pick) => {
    const a = g[field];
    const b = o[field];
    if (a == null && b == null) return;
    if (a != null && b != null && test(a, b)) fields[field] = pick(a, b);
    else disagreements.push({ field, gemini: a ?? null, openai: b ?? null });
  };
  // Prefer the longer address string (more complete: postcode, city) of the two agreeing ones.
  check('address', addressesAgree, (a, b) => (String(b).length > String(a).length ? b : a));
  check('website', (a, b) => websitesAgree(a, b) && !!pickWebsite(a, b), pickWebsite);
  check('capacity', capacitiesAgree, (a, b) => Math.min(Number(a), Number(b)));
  check('yearOpened', yearsAgree, (a) => Number(a));
  check('operator', operatorsAgree, (a, b) => (String(a).length <= String(b).length ? a : b));
  return { fields, disagreements };
}

/** Rough city boxes for the geocode sanity check. */
const CITY_BOXES = {
  nyc: { minLat: 40.49, maxLat: 40.92, minLng: -74.27, maxLng: -73.68 },
  london: { minLat: 51.28, maxLat: 51.70, minLng: -0.52, maxLng: 0.34 },
};
function inCity(lat, lng, city) {
  const b = CITY_BOXES[city];
  return !!b && lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
}

/**
 * A page whose spellings were folded together (VENUE_PAGE_NAME_FOLDS, BRO-8173) keeps the verified
 * facts researched under its old spellings: each field the page's own decision lacks is filled
 * from the first folded-in decision that has it. An address moves only with its geocode.
 * @param {{fields: object, how: object, geo: ?{lat:number,lng:number}}} d mutated and returned
 * @param {Array<{fields: object, how: object, geo: ?{lat:number,lng:number}}>} donors
 */
function fillFromFolded(d, donors) {
  for (const dd of donors) {
    for (const [f, val] of Object.entries(dd.fields || {})) {
      if (val == null || d.fields[f] != null) continue;
      if (f === 'address' && !dd.geo) continue;
      d.fields[f] = val;
      d.how[f] = dd.how[f];
      if (f === 'address') d.geo = dd.geo;
    }
  }
  return d;
}

/**
 * store["<market>/<slug>"], else the entry kept under a spelling that folds into that page
 * (VENUE_PAGE_NAME_FOLDS, BRO-8173), so a merged page keeps facts researched under its old name.
 */
function pickWithFolded(store, key, folds = require('./page-name-sources').VENUE_PAGE_NAME_FOLDS) {
  if (store[key]) return store[key];
  const { slugify } = require('./url-slug');
  const [market, slug] = key.split('/');
  for (const [from, to] of Object.entries(folds)) {
    const old = `${market}/${slugify(from)}`;
    if (slugify(to) === slug && old !== key && store[old]) return store[old];
  }
  return undefined;
}

module.exports = {
  pickWithFolded,
  fillFromFolded,
  streetKey,
  postcodeOf,
  addressesAgree,
  siteHost,
  pickWebsite,
  websitesAgree,
  capacitiesAgree,
  yearsAgree,
  operatorsAgree,
  agree,
  inCity,
  CITY_BOXES,
};
