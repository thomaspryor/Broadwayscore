/**
 * show-score-status.js — Shared ShowScore status extraction utilities
 *
 * Used by:
 * - enrich-ob-dates-from-showscore.js (one-time enrichment)
 * - update-show-status.js (weekly ShowScore refresh)
 * - discover-new-shows.js (SS-only candidate path)
 */

const { JSDOM } = require('jsdom');
const { sanitizeVenueForWrite, isKnownOffBroadwayVenue, isWestEndVenue } = require('./venue-classification');

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
  let venue = sanitizeVenueForWrite(venueRaw);

  // ShowScore's current template dropped the dedicated venue link entirely —
  // .show-page-v2__info-top-line now holds ONLY the Google Maps neighbourhood
  // link (confirmed across multiple current OB/WE show pages, 2026-09-13),
  // so the block above always fails closed now. When ShowScore disambiguates
  // a title (e.g. two shows both named "Safe House"), it appends the venue
  // in parens to <title> and the JSON-LD Product name — parse that as a
  // fallback rather than losing the venue entirely (Safe House / Theatre Row
  // never discovered, card #994-class skip-loop).
  //
  // sanitizeVenueForWrite is a denylist (rejects known junk), not an
  // allowlist — a title parenthetical that ISN'T a venue ("World Premiere",
  // "2026 Revival", a subtitle) would sail through it and get written as a
  // real venue, un-flagged, for ANY show (ship-check finding: this fallback
  // fires whenever the primary link is absent, which per the comment above
  // is now every show). Require a positive match against the known venue
  // lists instead of trusting the parenthetical on denylist-silence alone.
  // Off-West-End has no enumerated venue list to check against (it's defined
  // as "everything else in London" — isOffWestEndVenue is the NEGATION of the
  // West End list, so it would accept "World Premiere" just as readily as a
  // real venue and can't be used as a positive check here). Those shows get
  // no parenthetical rescue and stay null/deferred — the safe prior behavior.
  if (!venue) {
    const titleParen = doc.title?.match(/\(([^)]+)\)/);
    if (titleParen) {
      const candidate = titleParen[1].trim();
      if (isKnownOffBroadwayVenue(candidate) || isWestEndVenue(candidate)) {
        venue = sanitizeVenueForWrite(candidate);
      }
    }
  }

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
