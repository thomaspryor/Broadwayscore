/**
 * show-score-status.js — Shared ShowScore status extraction utilities
 *
 * Used by:
 * - enrich-ob-dates-from-showscore.js (one-time enrichment)
 * - update-show-status.js (weekly ShowScore refresh)
 * - discover-new-shows.js (SS-only candidate path)
 */

const { JSDOM } = require('jsdom');
const { sanitizeVenueForWrite } = require('./venue-classification');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Parse ShowScore short dates like "Mar 08" or "May 2026"
 * Returns YYYY-MM-DD string or null
 */
function parseShortDate(text) {
  const match = text.match(/([A-Za-z]+)\s+(\d+)/);
  if (!match) return null;
  const monthStr = match[1].toLowerCase().slice(0, 3);
  const num = parseInt(match[2]);
  const month = MONTHS[monthStr];
  if (month === undefined) return null;
  const currentYear = new Date().getFullYear();
  if (num > 31) {
    // "May 2026" — year is the number, use last day of month
    const lastDay = new Date(num, month + 1, 0).getDate();
    return `${num}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  }
  // "Mar 08" — infer year (current year, or next year if >3 months ago)
  let year = currentYear;
  const now = new Date();
  const candidate = new Date(year, month, num);
  if (candidate < new Date(now.getFullYear(), now.getMonth() - 3, 1)) {
    year++;
  }
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(num).padStart(2, '0')}`;
}

/**
 * Extract show status from ShowScore HTML page.
 * Parses the `.show-page-v2__info-top-line` element.
 *
 * Returns { ssStatus, openingDate, closingDate, venue, raw } or null
 *
 * Status mapping:
 *   "Opens Mar 08"  → { ssStatus: 'previews', openingDate: '2026-03-08' }
 *   "Open run"      → { ssStatus: 'open' }
 *   "Ends Mar 28"   → { ssStatus: 'open', closingDate: '2026-03-28' }
 *   "Closed"        → { ssStatus: 'closed' }
 */
function extractStatusFromHtml(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const topLine = doc.querySelector('.show-page-v2__info-top-line');
  if (!topLine) {
    dom.window.close();
    return null;
  }

  const statusText = topLine.childNodes[0]?.textContent?.trim() || '';
  if (!statusText) {
    dom.window.close();
    return null;
  }

  // Extract venue. The first <a> in this element is sometimes ShowScore's
  // neighbourhood-filter link ("Midtown E", "Soho/Tribeca") rather than the
  // venue link — sanitizeVenueForWrite fails closed on those (card #994).
  const venueLink = topLine.querySelector('a');
  const venueFull = venueLink?.textContent?.trim() || '';
  const venueRaw = venueFull.replace(/^(NYC|London|Chicago|LA):\s*/i, '').trim() || null;
  const venue = sanitizeVenueForWrite(venueRaw);

  let ssStatus = null;
  let openingDate = null;
  let closingDate = null;

  if (statusText.startsWith('Opens ')) {
    ssStatus = 'previews';
    openingDate = parseShortDate(statusText.replace('Opens ', ''));
  } else if (statusText === 'Open run') {
    ssStatus = 'open';
  } else if (statusText.startsWith('Ends ')) {
    ssStatus = 'open';
    closingDate = parseShortDate(statusText.replace('Ends ', ''));
  } else if (statusText === 'Closed') {
    ssStatus = 'closed';
  }

  dom.window.close();
  return { ssStatus, openingDate, closingDate, venue, raw: statusText };
}

module.exports = { extractStatusFromHtml, parseShortDate };
