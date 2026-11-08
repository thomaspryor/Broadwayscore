'use strict';
// Fallback publish dates for pages that carry none (BRO-6762 hole 3).
// Before ingest skips a page as publish-date-unresolved, two weaker sources are
// tried, each only when it lands inside the show's plausible review window:
//   1. an aggregator listing date the caller passes (--fallback-publish-date);
//   2. the Wayback Machine's FIRST capture of the URL. A capture is an upper
//      bound on the publish date (the page existed by then), so it is only
//      accepted when it falls within `windowAfterOpeningDays` of opening night;
//      a first capture months later proves nothing about when it was published.
// Never overrides a page or byline date: callers use this only when the
// resolver found none.

const DAY = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function inReviewWindow(date, openingDate, { daysBefore = 3, daysAfter = 30 } = {}) {
  if (!ISO.test(String(date || '')) || !ISO.test(String(openingDate || '').slice(0, 10))) return false;
  const d = Date.parse(date + 'T00:00:00Z');
  const o = Date.parse(String(openingDate).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(d) || Number.isNaN(o)) return false;
  return d >= o - daysBefore * DAY && d <= o + daysAfter * DAY;
}

/** CDX timestamp (YYYYMMDDhhmmss) -> YYYY-MM-DD, or null. */
function cdxTimestampToDate(ts) {
  const m = String(ts || '').match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Earliest 200-status Wayback capture date for a URL, or null. `fetchJson` is
 * injectable for tests: (url) => Promise<any>.
 */
async function archiveFirstCaptureDate(url, { fetchJson } = {}) {
  const get = fetchJson || (async (u) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(u, { signal: ctl.signal });
      if (!r.ok) return null;
      return await r.json();
    } finally { clearTimeout(t); }
  });
  const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp&filter=statuscode:200&limit=1`;
  let rows;
  try { rows = await get(cdx); } catch { return null; }
  if (!Array.isArray(rows) || rows.length < 2) return null; // row 0 is the header
  const first = Array.isArray(rows[1]) ? rows[1][0] : rows[1];
  return cdxTimestampToDate(first);
}

/**
 * Pick a fallback date. Returns { publishDate, dateSource } or null.
 * @param {object} a
 * @param {string|null} a.listingDate - aggregator listing date from the caller
 * @param {string|null} a.listingSource - e.g. 'dtli', 'bww-roundup'
 * @param {string|null} a.archiveDate - first-capture date (already fetched)
 * @param {string|null} a.openingDate
 */
function pickFallbackPublishDate({ listingDate = null, listingSource = null, archiveDate = null, openingDate = null } = {}) {
  if (listingDate && ISO.test(listingDate) && inReviewWindow(listingDate, openingDate, { daysBefore: 7, daysAfter: 60 })) {
    return { publishDate: listingDate, dateSource: `aggregator-listing${listingSource ? ':' + listingSource : ''}` };
  }
  if (archiveDate && inReviewWindow(archiveDate, openingDate)) {
    return { publishDate: archiveDate, dateSource: 'archive-first-capture' };
  }
  return null;
}

/**
 * BRO-6801: the aggregator listing date to hand to ingest as --fallback-publish-date for one
 * missing URL, or null. Only a real YYYY-MM-DD that sits inside THIS run's window counts: not
 * before the run window start (previews/opening minus the audit's 30-day slack, so a revival's
 * prior-production listing is refused) and not past the window pickFallbackPublishDate accepts
 * (opening + 60 days). `runWindowStartMs` is injected to keep this file dependency-free.
 */
function listingDateForRun(rawDate, show, runWindowStartMs) {
  const d = String(rawDate || '').slice(0, 10);
  if (!ISO.test(d) || !show || !show.openingDate) return null;
  const t = Date.parse(d + 'T00:00:00Z');
  const start = typeof runWindowStartMs === 'function' ? runWindowStartMs(show) : null;
  if (!Number.isFinite(t) || (start !== null && t < start)) return null;
  return inReviewWindow(d, String(show.openingDate).slice(0, 10), { daysBefore: 7, daysAfter: 60 }) ? d : null;
}

/** CLI args that hand an aggregator listing date to ingest-review-from-url.js (BRO-6801). */
function fallbackDateArgs(listing) {
  if (!listing || !listing.date) return [];
  return [`--fallback-publish-date=${listing.date}`, `--fallback-date-source=${listing.source || ''}`];
}

/**
 * BRO-6762 hole 3, gathering side: a discovered stub the writer would park for having no
 * publish date (gather-reviews.js, The Stage's year-less /reviews/<slug> URLs, BRO-7084) gets
 * the same weaker date source the audit's ingest already uses: the archive.org FIRST capture,
 * accepted only inside the show's review window (pickFallbackPublishDate). A page first
 * captured years before this opening stays undated, so the park still fires for an earlier
 * staging's review. Never throws; returns { publishDate, dateSource } or null.
 * `fetchJson` is injectable for tests.
 */
async function fallbackDateForUndatedStub({ url, openingDate, fetchJson } = {}) {
  if (!url || !openingDate || !ISO.test(String(openingDate).slice(0, 10))) return null;
  let archiveDate = null;
  try { archiveDate = await archiveFirstCaptureDate(url, { fetchJson }); } catch { return null; }
  return pickFallbackPublishDate({ archiveDate, openingDate: String(openingDate).slice(0, 10) });
}

module.exports = { fallbackDateArgs, listingDateForRun, inReviewWindow, cdxTimestampToDate, archiveFirstCaptureDate, pickFallbackPublishDate, fallbackDateForUndatedStub };
