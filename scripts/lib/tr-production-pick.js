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
 * Older (PDF-era) links (/archive/volume/…) carry none and count as undated.
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

/**
 * @param {Array<{title: string, venue: string, link: string}>} titleMatches
 * @param {object} show shows.json row
 * @param {{hintVenue?: string|null, isLondonVenue: (venue: string) => boolean}} opts
 * @returns {{title: string, venue: string, link: string}|null}
 */
function pickTrProduction(titleMatches, show, opts) {
  const { hintVenue = null, isLondonVenue } = opts || {};
  let pool = Array.isArray(titleMatches) ? titleMatches : [];
  const win = pressNightWindow(show || {});
  if (win && pool.length) {
    const inWindow = pool.filter(r => { const am = archiveMonth(r.link); return am != null && am >= win.start && am <= win.end; });
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
  return pool[0];
}

module.exports = { pickTrProduction, archiveMonth, pressNightWindow };
