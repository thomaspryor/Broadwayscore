'use strict';

/**
 * Choose which Theatre Record search result is THIS show's production
 * (BRO-4851).
 *
 * The old pick in extract-theatre-record.js took the first title match at
 * any London venue, and TR search sorts newest first. For the 2024 Wyndham's
 * Oedipus that was the 2025 Old Vic Oedipus, and its 15 reviews were saved
 * under the wrong show (pilot run 37713373821).
 *
 * TR archive links carry the issue month of the production's press night:
 *   /archive/2025/2/17206-oedipus
 * Older (PDF-era) links (/archive/volume/V/dest/N_slug) carry none, but the
 * volume is the calendar year (V + 1980) and N counts fortnightly issues from
 * 1, so they date to about a month (BRO-6127: 97 of 117 picked links land on
 * the opening month exactly; the misses are mostly same-title revivals picked
 * from the wrong year, e.g. Joseph 2019 taking the 2021 Palladium issue).
 * /archive/volume/V/page/P links give the year only. Other links are undated.
 *
 * Order of preference, within the date window when the show has dates:
 *   1. the listing's hint venue, 2. the show's own venue, 3. any London
 *   venue, 4. the first remaining result.
 * A CLOSED show with dates never takes a dated result outside its window: no
 * pick is better than another production's reviews. Open shows keep the old
 * fallback (long-runners' shows.json dates can predate TR's archive).
 */

const WINDOW_MONTHS_BEFORE = 1;
const WINDOW_MONTHS_AFTER = 2;
// Slack on an estimated (PDF-era) month: the issue number is a fortnight count,
// not a date, and a press night can land in either neighbouring issue.
const PDF_ERA_SLACK_MONTHS = 2;
const TR_VOLUME_YEAR_BASE = 1980;

/** "YYYY-MM-DD" → months since year 0, or null. */
function monthIndex(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})/);
  return m ? Number(m[1]) * 12 + (Number(m[2]) - 1) : null;
}

/** TR archive link → months since year 0, or null (undated / PDF-era link). */
function archiveMonth(link) {
  const m = String(link || '').match(/\/archive\/(\d{4})\/(\d{1,2})\//);
  return m ? Number(m[1]) * 12 + (Number(m[2]) - 1) : null;
}

/**
 * PDF-era link → { month } (volume/dest, estimated), { year } (volume/page) or
 * null (anything else, including slugs with no issue number).
 */
function pdfEraDate(link) {
  const dest = String(link || '').match(/\/archive\/volume\/(\d{1,3})\/dest\/(\d{1,2})(?!\d)/);
  if (dest) {
    const issue = Number(dest[2]);
    if (issue < 1 || issue > 26) return null;
    return { month: (TR_VOLUME_YEAR_BASE + Number(dest[1])) * 12 + Math.floor((issue - 1) / 2) };
  }
  const page = String(link || '').match(/\/archive\/volume\/(\d{1,3})\/page\/\d+/);
  return page ? { year: TR_VOLUME_YEAR_BASE + Number(page[1]) } : null;
}

/** 'in' | 'out' | 'unknown': does this result's date fit the press-night window. */
function windowFit(link, win) {
  const am = archiveMonth(link);
  if (am != null) return am >= win.start && am <= win.end ? 'in' : 'out';
  const pdf = pdfEraDate(link);
  if (!pdf) return 'unknown';
  if (pdf.month != null) {
    return pdf.month >= win.start - PDF_ERA_SLACK_MONTHS && pdf.month <= win.end + PDF_ERA_SLACK_MONTHS ? 'in' : 'out';
  }
  const lo = Math.floor((win.start - PDF_ERA_SLACK_MONTHS) / 12);
  const hi = Math.floor((win.end + PDF_ERA_SLACK_MONTHS) / 12);
  return pdf.year >= lo && pdf.year <= hi ? 'in' : 'out';
}

/**
 * Press-night window in month indices, or null when the show has no dates.
 * Anchored on the opening (press night) when known, else the first preview.
 */
function pressNightWindow(show) {
  const anchor = monthIndex(show.openingDate) ?? monthIndex(show.previewsStartDate);
  if (anchor == null) return null;
  const firstPreview = monthIndex(show.previewsStartDate) ?? anchor;
  return { start: Math.min(firstPreview, anchor) - WINDOW_MONTHS_BEFORE, end: anchor + WINDOW_MONTHS_AFTER };
}

function venueKey(v) {
  return String(v || '').toLowerCase().replace(/,.*/, '').replace(/^the\s+/, '').replace(/\s+theatre$/, '').trim();
}

// Search cards may fall back to a navigation link. Only production HTML
// pages or PDF routes can supply reviews; archive/listings indexes cannot.
// Keep volume/page links: the BRO-6427 probe used these for actual PDFs.
function isProductionLink(link) {
  try {
    const url = new URL(link);
    if (!/^https?:$/.test(url.protocol) || !/^(?:www\.)?theatrerecord\.com$/.test(url.hostname)) return false;
    return /^\/archive\/(?:(?:\d{4}\/[^/]+|latest)\/\d+-[^/]+|volume\/\d+\/(?:page\/\d+|dest\/[^/]+)|issue\/\d+(?:\/(?:page\/\d+|dest\/[^/]+))?)\/?$/.test(url.pathname);
  } catch (_) {
    return false;
  }
}

/**
 * @param {Array<{title: string, venue: string, link: string}>} titleMatches
 * @param {object} show shows.json row
 * @param {{hintVenue?: string|null, isLondonVenue: (venue: string) => boolean}} opts
 * @returns {{title: string, venue: string, link: string}|null}
 */
function pickTrProduction(titleMatches, show, opts) {
  const { hintVenue = null, isLondonVenue } = opts || {};
  let pool = Array.isArray(titleMatches) ? titleMatches.filter(r => isProductionLink(r.link)) : [];
  const win = pressNightWindow(show || {});
  if (win && pool.length) {
    const inWindow = pool.filter(r => windowFit(r.link, win) === 'in');
    if (inWindow.length) pool = inWindow;
    else if (show.status === 'closed') pool = pool.filter(r => archiveMonth(r.link) == null);
  }
  if (!pool.length) return null;

  if (hintVenue) {
    const hint = venueKey(hintVenue.replace(/,\s*London$/i, ''));
    const hit = pool.find(r => { const rv = venueKey(r.venue); return rv && (rv.includes(hint) || hint.includes(rv)); });
    if (hit) return hit;
  }
  const own = venueKey(show && show.venue);
  if (own) {
    const hit = pool.find(r => { const rv = venueKey(r.venue); return rv && (rv.includes(own) || own.includes(rv)); });
    if (hit) return hit;
  }
  if (typeof isLondonVenue === 'function') {
    const hit = pool.find(r => isLondonVenue(r.venue));
    if (hit) return hit;
  }
  // Nothing in the window, none at our venue, none in London: a regional
  // production of the same title (Chester's 2021 Pride and Prejudice for the
  // Criterion run, which even lands inside the date window), not ours.
  if (win && show.status === 'closed' && typeof isLondonVenue === 'function' && pool[0].venue) return null;
  return pool[0];
}

const { titlesMatch } = require('./title-normalization.js');

// TR appends a tagline after a colon ("CURTAINS: A MUSICAL WHODUNNIT" for our
// "Curtains"); the part before it is the title (BRO-6127).
function trTitleMatches(trTitle, showTitle) {
  return titlesMatch(trTitle, showTitle) || (/:\s/.test(trTitle) && titlesMatch(trTitle.split(/:\s/)[0], showTitle));
}

module.exports = { trTitleMatches, pickTrProduction, archiveMonth, pdfEraDate, windowFit, monthIndex, pressNightWindow };
