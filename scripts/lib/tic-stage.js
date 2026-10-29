'use strict';

/**
 * Pure staging rules for theatreinchicago.com productions (BRO-6518):
 * which crawled productions become shows.json entries, and what the entry
 * looks like. No I/O; scripts/tic-stage-shows.js does the fetching.
 */

const { isExcludedType, mapShowType } = require('./theatreinchicago');
const { foldDiacritics } = require('./title-match');

const MIN_REVIEWS = 3;
const CHICAGO_METRO = 'chicago-il'; // data/venue-metros.json metro slug (BRO-6515)

// Broadway In Chicago / touring houses: their productions are national tours
// (tracked in data/tour-schedules.json), not local productions.
const TOUR_HOUSES = [
  /cibc theat/i, /cadillac palace/i, /nederlander/i, /broadway playhouse/i, /auditorium theat/i,
  /oriental theat/i, /james m\.? nederlander/i, /lyric opera/i, /ford center/i,
];

const VIRTUAL_VENUE = /online stream|virtual|livestream|streaming|\bzoom\b|on demand|audio play/i;

function normTitle(t) {
  return foldDiacritics(String(t || ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(t) {
  return foldDiacritics(String(t || ''))
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Distinct (outlet) reviews that carry a link to the full review. */
function linkedReviews(page) {
  const seen = new Set();
  const out = [];
  for (const r of page.reviews || []) {
    if (!r.url) continue;
    const key = `${r.outlet}|${r.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * First-pass gate on the reviews page alone (no detail fetch yet).
 * Returns { ok:true } or { ok:false, reason }.
 */
function prefilter(page) {
  if (!page || page.empty) return { ok: false, reason: 'empty' };
  const venue = page.venue || '';
  if (VIRTUAL_VENUE.test(venue)) return { ok: false, reason: 'virtual' };
  if (TOUR_HOUSES.some((re) => re.test(venue))) return { ok: false, reason: 'tour-house' };
  const outlets = new Set(linkedReviews(page).map((r) => r.outlet));
  if (outlets.size < MIN_REVIEWS) return { ok: false, reason: 'under-3-outlets' };
  return { ok: true };
}

/** Second gate once the detail page is known. */
function detailFilter(detail) {
  if (!detail || detail.empty) return { ok: false, reason: 'no-detail' };
  if (isExcludedType(detail.showType)) return { ok: false, reason: `type:${detail.showType}` };
  return { ok: true };
}

/** "<Theater>, <City>, IL" from the detail page (address ends with the city). */
const IL_CITIES = ['Chicago Heights', 'Oak Park', 'Oak Brook', 'Oakbrook Terrace', 'Highland Park', 'Arlington Heights', 'Lake Forest', 'Lake Zurich', 'Des Plaines', 'Park Ridge', 'Glen Ellyn', 'Downers Grove', 'La Grange', 'Forest Park', 'Morton Grove', 'Crystal Lake', 'Western Springs', 'Evergreen Park', 'Blue Island', 'Park Forest', 'Richton Park', 'St. Charles', 'Chicago', 'Evanston', 'Skokie', 'Glencoe', 'Lincolnshire', 'Aurora', 'Naperville', 'Wilmette', 'Winnetka', 'Rosemont', 'Schaumburg', 'Woodstock', 'Joliet', 'Elgin', 'Batavia', 'Geneva', 'Wheaton', 'Lombard', 'Berwyn', 'Cicero', 'Northbrook', 'Glenview', 'Niles', 'Lincolnwood', 'Palatine', 'Waukegan', 'Libertyville', 'Mundelein', 'Lemont', 'Highwood', 'Barrington', 'Harvey', 'Steger', 'Palos Heights', 'Palos Park', 'Hinsdale', 'Elmhurst', 'Villa Park', 'Bolingbrook', 'Orland Park', 'Tinley Park', 'Mokena', 'Munster', 'Oak Lawn', 'Skokie'];
const IN_CITIES = ['Hammond', 'Gary', 'Munster', 'Valparaiso', 'Michigan City'];

/** "<Theater>, <City>, <ST>" from the detail page (the address ends with the city). */
function venueLine(detail, page) {
  const theater = (detail && detail.venue) || String(page.venue || '').split(/\s+at\s+/i).pop();
  const addr = String((detail && detail.address) || '');
  // The address is "<street> <City>": the city is the last place name in it, so
  // "1010 Chicago Ave Evanston" is Evanston and "Chicago Heights" is not Chicago.
  let best = null;
  for (const city of [...IL_CITIES, ...IN_CITIES]) {
    const re = new RegExp(`\\b${city.replace('.', '\\.')}\\b`, 'gi');
    let m;
    while ((m = re.exec(addr))) {
      const end = m.index + city.length;
      if (!best || end > best.end || (end === best.end && city.length > best.city.length)) best = { city, end };
    }
  }
  const city = best ? best.city : 'Chicago';
  const state = IN_CITIES.includes(city) && !/\bIL\b/.test(addr) ? 'IN' : 'IL';
  return `${theater}, ${city}, ${state}`;
}

function pickYear(openingDate) {
  return openingDate ? openingDate.slice(0, 4) : null;
}

/**
 * Build the add-show `show` object. `dates.openingDate` is the earliest
 * publish date among the fetched reviews (proxy for press opening).
 */
function buildShowEntry({ page, detail, dates, discoveredAt }) {
  const year = pickYear(dates.openingDate);
  const base = slugify(page.title);
  const id = `${base}-regional-${year}`;
  const closing = detail && detail.closingDate ? detail.closingDate : page.closingDate;
  const today = discoveredAt.slice(0, 10);
  // No "Thru" date: a run opened >120 days ago is treated as closed (open-ended listings are rare).
  const daysOld = (Date.parse(today) - Date.parse(dates.openingDate)) / 86400000;
  const status = closing ? (closing < today ? 'closed' : 'open') : (daysOld > 120 ? 'closed' : 'open');
  const entry = {
    id,
    title: page.title,
    slug: id,
    venue: venueLine(detail, page), // venue-write-guard-ok: staged entry only; add-show runs sanitizeVenueForWrite on apply
    status,
    type: mapShowType(detail && detail.showType),
    category: 'regional',
    market: 'regional',
    openingDate: dates.openingDate,
    openingDateSource: 'tic-first-review',
    discoverySource: 'theatreinchicago',
    localOnly: true,
    // theatreinchicago covers Chicagoland only (suburbs and Hammond-area IN included): one metro hub.
    city: CHICAGO_METRO,
    discoveredAt,
    evidenceUrls: [`https://www.theatreinchicago.com/${page.slug || 'show'}/${page.id}/`],
  };
  if (closing) entry.closingDate = closing;
  return entry;
}

/**
 * Match a staged production against existing shows. Returns the existing show
 * (a duplicate) or null. Titles compare normalised; a tour or earlier run of
 * the same title only counts when its dates are within ~120 days of this one.
 */
function findDuplicate(entry, existingShows) {
  const nt = normTitle(entry.title);
  const open = Date.parse(entry.openingDate);
  for (const s of existingShows) {
    if (normTitle(s.title) !== nt) continue;
    const so = Date.parse(s.openingDate || '');
    if (s.category === 'regional' && /, (chicago|[a-z. ]+), (il|in)\b/i.test(s.venue || '') && Number.isFinite(open) && Number.isFinite(so) && Math.abs(open - so) < 120 * 86400000) return s;
    if (s.category === 'tour') {
      if (Number.isFinite(open) && Number.isFinite(so) && Math.abs(open - so) < 400 * 86400000) return s;
      continue;
    }
    if (Number.isFinite(open) && Number.isFinite(so) && Math.abs(open - so) < 120 * 86400000) return s;
  }
  return null;
}

/**
 * Two different companies can stage the same title in the same year, and the id
 * is a live URL: on a collision (existing show or already staged) the venue
 * slug is appended, then the theatreinchicago id as a last resort.
 */
function dedupeId(entry, page, taken) {
  if (!taken.has(entry.id)) return entry;
  const venueSlug = slugify(String(entry.venue).split(',')[0]);
  for (const suffix of [venueSlug, `${venueSlug}-${page.id}`, String(page.id)]) {
    const id = `${entry.id}-${suffix}`;
    if (!taken.has(id)) { entry.id = id; entry.slug = id; return entry; }
  }
  return entry;
}

module.exports = {
  dedupeId,
  MIN_REVIEWS, TOUR_HOUSES, VIRTUAL_VENUE,
  normTitle, slugify, linkedReviews, prefilter, detailFilter, venueLine, buildShowEntry, findDuplicate,
};
