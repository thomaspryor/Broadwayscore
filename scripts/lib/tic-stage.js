'use strict';

/**
 * Pure staging rules for theatreinchicago.com productions (BRO-6518):
 * which crawled productions become shows.json entries, and what the entry
 * looks like. No I/O; scripts/tic-stage-shows.js does the fetching.
 */

const { isExcludedType, mapShowType } = require('./theatreinchicago');

const MIN_REVIEWS = 3;

// Broadway In Chicago / touring houses: their productions are national tours
// (tracked in data/tour-schedules.json), not local productions.
const TOUR_HOUSES = [
  /cibc theat/i, /cadillac palace/i, /nederlander/i, /broadway playhouse/i, /auditorium theat/i,
  /oriental theat/i, /james m\.? nederlander/i, /lyric opera/i, /ford center/i,
];

const VIRTUAL_VENUE = /online stream|virtual|livestream|streaming|\bzoom\b|on demand|audio play/i;

function normTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(t) {
  return String(t || '')
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
function venueLine(detail, page) {
  const theater = (detail && detail.venue) || String(page.venue || '').split(/\s+at\s+/i).pop();
  const addr = (detail && detail.address) || '';
  // The address text is "<street> <City>"; the last capitalised run is the city.
  const cityMatch = addr.match(/\b(Chicago|Evanston|Skokie|Oak Park|Oak Brook|Oakbrook Terrace|Glencoe|Highland Park|Lincolnshire|Aurora|Naperville|Arlington Heights|Wilmette|Winnetka|Lake Forest|Des Plaines|Park Ridge|Rosemont|Schaumburg|Woodstock|Joliet|Elgin|Batavia|Geneva|St\. Charles|Glen Ellyn|Wheaton|Lombard|Downers Grove|La Grange|Berwyn|Cicero|Forest Park|Northbrook|Glenview|Morton Grove|Niles|Lincolnwood|Palatine|Crystal Lake|Waukegan|Libertyville|Mundelein|Lemont|Hammond|Gary|Munster|Highwood|Barrington|Western Springs|Evergreen Park|Blue Island|Harvey|Chicago Heights|Park Forest|Steger|Richton Park|Lake Zurich)\b/i);
  const city = cityMatch ? cityMatch[1] : 'Chicago';
  return `${theater}, ${city}, IL`;
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
  const status = closing && closing < discoveredAt.slice(0, 10) ? 'closed' : 'open';
  const entry = {
    id,
    title: page.title,
    slug: id,
    venue: venueLine(detail, page),
    status,
    type: mapShowType(detail && detail.showType),
    category: 'regional',
    market: 'regional',
    openingDate: dates.openingDate,
    openingDateSource: 'tic-first-review',
    discoverySource: 'theatreinchicago',
    localOnly: true,
    discoveredAt,
    evidenceUrls: [`https://www.theatreinchicago.com/${page.slug}/${page.id}/`],
  };
  if (closing) entry.closingDate = closing;
  if (status === 'closed' && !closing) delete entry.status;
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
    if (s.category === 'regional' && /chicago/i.test(s.venue || '')) return s;
    if (s.category === 'tour') {
      if (Number.isFinite(open) && Number.isFinite(so) && Math.abs(open - so) < 400 * 86400000) return s;
      continue;
    }
    if (Number.isFinite(open) && Number.isFinite(so) && Math.abs(open - so) < 120 * 86400000) return s;
  }
  return null;
}

module.exports = {
  MIN_REVIEWS, TOUR_HOUSES, VIRTUAL_VENUE,
  normTitle, slugify, linkedReviews, prefilter, detailFilter, venueLine, buildShowEntry, findDuplicate,
};
