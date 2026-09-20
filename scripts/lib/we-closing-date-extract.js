/**
 * we-closing-date-extract.js
 *
 * Pure extraction of an announced West End closing/booking-end date from a
 * show's booking page (westendtheatre.com show page or the production's
 * officialUrl). Unlike broadway.com's per-show schedule page (a full
 * performance calendar — see audit-closing-dates.js's parseScheduleDates),
 * WE booking pages state a single "Booking until DD Month YYYY" line rather
 * than listing every performance. Grabbing every date on the page (the
 * Broadway approach) would pick up nav/footer/other-show promo dates just as
 * easily as the real one, so extraction here is keyword-anchored instead:
 * only dates immediately preceded by an "until/through/to/extended" phrase
 * are candidates, and the latest such candidate wins (an "extended until X"
 * line legitimately outranks an older "until Y" mention on the same page).
 *
 * See CLAUDE.md rule 15 — extracted to lib + require()'d by the test so a
 * regression in the real extractor fails the test, not a copy of it.
 */

'use strict';

const MONTH_RE = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';

// UK date order: DD Month YYYY (e.g. "12 July 2026", "Sun 12 Jul 2026").
// Day-of-week prefix and comma-after-day are both optional.
const UK_DATE_RE = new RegExp(
  `\\b(?:[A-Z][a-z]+\\s+)?(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(${MONTH_RE})\\.?\\s+(\\d{4})\\b`,
  'i'
);

// US date order (Month DD, YYYY) — kept as a fallback for officialUrl pages,
// which may be run by a US-based ticketing platform even for a West End show.
const US_DATE_RE = new RegExp(
  `\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
  'i'
);

// Year-LESS UK date: "must end 31 May" (the real captured phrase from
// draculawestend.com's closingDateSource for dracula-west-end-2025 — it has
// no year at all; announcement copy commonly omits it when the close is
// "this year" from the reader's perspective). Tried only as a fallback when
// UK_DATE_RE finds nothing in the window, and only matched when NOT
// immediately followed by a 4-digit year (negative lookahead) so it never
// double-parses a year-bearing date as a truncated year-less one.
const UK_DATE_NO_YEAR_RE = new RegExp(
  `\\b(?:[A-Z][a-z]+\\s+)?(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(${MONTH_RE})\\.?(?!\\s*\\d{4})\\b`,
  'i'
);

// Sanity window for an extracted year, mirrors audit-closing-dates.js's
// buildYearPattern() (TODAY_YEAR..+3): rejects a plausible-shaped but wrong
// year that happened to land near an anchor phrase (e.g. a copyright notice
// or an unrelated archived date), same failure class Codex's adversarial
// review flagged for the unbounded original. Allows a little past-slack
// (a booking page updated right after close can show a same-week past date).
const YEAR_WINDOW_PAST_DAYS = 30;
const YEAR_WINDOW_FUTURE_DAYS = 3 * 365;

function isDateInSaneWindow(dateStr, now) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const min = new Date(now.getTime() - YEAR_WINDOW_PAST_DAYS * 86400000);
  const max = new Date(now.getTime() + YEAR_WINDOW_FUTURE_DAYS * 86400000);
  return d >= min && d <= max;
}

// Keyword phrases that anchor a trustworthy "this date is the booking/run
// end" reading. Each capture group is the phrase immediately preceding the
// date text (kept short — just enough context to log for human review).
// Deliberately keyword-STRICT, not a bare "ends" catch-all: an earlier draft
// included `/\bends?\s*(?:on|its run on)?/i`, which matches "ends" anywhere in
// ordinary prose (synopsis text, a pull-quote, "Act One ends with...") with no
// booking-page context, and — combined with "latest date wins" below — a
// spurious match on unrelated body copy could outrank or silently replace the
// real booking-until date. Every phrase here requires an explicit run/booking
// verb. "must end" is confirmed real West End booking-page copy (see
// draculawestend.com's closingDateSource: "must end 31 May" for
// dracula-west-end-2025, captured 2026-05-14 in the manual correction this
// audit exists to automate).
const ANCHOR_PHRASES = [
  /book(?:ing)?\s*(?:now\s*)?(?:until|through|thru|to)/i,
  /performances?\s*(?:until|through|thru|to)/i,
  /(?:extended|extends|extension)\s*(?:until|to)/i,
  /final\s*performance[s]?\s*(?:on|is|will be|date)?/i,
  /last\s*performance[s]?\s*(?:on|is)?/i,
  /(?:runs?|running)\s*(?:until|through|thru|to)/i,
  /must\s*end(?:s)?(?:\s*by)?/i,
  /run\s*ends?\s*(?:on)?/i,
];

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[^]*?<\/script>/g, ' ')
    .replace(/<style[^]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseUkDate(m, now) {
  const [, day, mon, year] = m;
  const d = new Date(`${day} ${mon.replace(/^Sept$/i, 'Sep')} ${year}`);
  if (isNaN(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  return isDateInSaneWindow(iso, now) ? iso : null;
}

function parseUsDate(m, now) {
  const [, mon, day, year] = m;
  const d = new Date(`${mon.replace(/^Sept$/i, 'Sep')} ${day}, ${year}`);
  if (isNaN(d.getTime())) return null;
  const iso = d.toISOString().slice(0, 10);
  return isDateInSaneWindow(iso, now) ? iso : null;
}

// "31 May" with no year: try this year first; if that reading is already
// more than a week in the past, the announcement almost certainly means NEXT
// year's 31 May (a booking page doesn't advertise a date that already
// passed). A week of slack (not zero) avoids flipping a booking-until date
// that's merely a few days old to next year on a stale scrape.
function parseUkDateNoYear(m, now) {
  const [, day, mon] = m;
  const monClean = mon.replace(/^Sept$/i, 'Sep');
  const thisYear = now.getFullYear();
  let d = new Date(`${day} ${monClean} ${thisYear}`);
  if (isNaN(d.getTime())) return null;
  if (d.getTime() < now.getTime() - 7 * 86400000) {
    d = new Date(`${day} ${monClean} ${thisYear + 1}`);
  }
  const iso = d.toISOString().slice(0, 10);
  return isDateInSaneWindow(iso, now) ? iso : null;
}

/**
 * Find every keyword-anchored date in `text`, in document order.
 * @param {string} text
 * @param {Date} [now] - injectable for tests; defaults to the real current time
 * @returns {Array<{date: string, quote: string, index: number}>}
 */
function findAnchoredDates(text, now = new Date()) {
  const found = [];
  const anchorUnion = new RegExp(ANCHOR_PHRASES.map(r => `(?:${r.source})`).join('|'), 'gi');
  let am;
  while ((am = anchorUnion.exec(text)) !== null) {
    const windowText = text.slice(am.index, am.index + am[0].length + 40);
    let dateMatch = UK_DATE_RE.exec(windowText);
    let date = dateMatch ? parseUkDate(dateMatch, now) : null;
    if (!date) {
      dateMatch = US_DATE_RE.exec(windowText);
      date = dateMatch ? parseUsDate(dateMatch, now) : null;
    }
    if (!date) {
      dateMatch = UK_DATE_NO_YEAR_RE.exec(windowText);
      date = dateMatch ? parseUkDateNoYear(dateMatch, now) : null;
    }
    if (date) {
      // dateMatch.index is relative to windowText, which itself starts at
      // am.index (not am.index + am[0].length) — the absolute end of the
      // date match is am.index + dateMatch.index + dateMatch[0].length.
      // (An earlier draft double-counted am[0].length here, which padded
      // `quote` — the only field a human reviewer sees to verify the
      // extraction — with trailing garbage past the real date.)
      const quoteStart = Math.max(0, am.index - 10);
      const quoteEnd = am.index + dateMatch.index + dateMatch[0].length;
      found.push({
        date,
        quote: text.slice(quoteStart, Math.min(text.length, quoteEnd)).trim(),
        index: am.index,
      });
    }
  }
  return found;
}

// Title-confirmation guard — mirrors pageMatchesShow() in
// audit-closing-dates.js / pageMatchesShowTitle() in closing-date-discovery.js.
// Required before trusting a page's extracted date: without it, a stale
// cached slug-map URL that now resolves to a different production (venue
// reuse, WET slug reassignment) could silently apply a wrong show's date.
function pageMatchesShowTitle(text, showTitle) {
  if (!text || !showTitle) return false;
  const haystack = text.toLowerCase();
  const words = showTitle.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
  if (words.length === 0) {
    const tokens = showTitle.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return tokens.some(t => new RegExp(`\\b${t}\\b`).test(haystack));
  }
  return words.some(w => haystack.includes(w));
}

/**
 * Extract the latest announced booking/closing date from a show's booking
 * page HTML.
 *
 * @param {string} html - raw page HTML
 * @param {string} showTitle - stored show title, for the title-match guard
 * @returns {{date: string, quote: string}|null} - null if the page doesn't
 *   confirm the show, or no anchored date was found.
 */
function extractWestEndClosingDate(html, showTitle, now) {
  const result = extractWestEndClosingDateDetailed(html, showTitle, now);
  return result.date ? { date: result.date, quote: result.quote } : null;
}

/**
 * Same extraction as extractWestEndClosingDate(), but on failure also
 * reports WHY (title_mismatch vs no_date_found) so the caller can route a
 * "page no longer confirms this show" signal into a possibly-closed review
 * flow (scripts/lib/closing-audit-classify.js's classifyMissingSchedule,
 * kind='title_mismatch'|'empty_schedule') instead of a silent error bucket.
 * See audit-closing-dates.js's title_mismatch handling for why this
 * distinction matters — a page that no longer mentions the show is at least
 * as strong a "probably closed" signal as an empty one.
 *
 * @param {Date} [now] - injectable for tests; defaults to the real current time
 * @returns {{date: string, quote: string}|{date: null, kind: 'title_mismatch'|'no_date_found'}}
 */
function extractWestEndClosingDateDetailed(html, showTitle, now = new Date()) {
  const text = stripHtml(html);
  if (!pageMatchesShowTitle(text, showTitle)) return { date: null, kind: 'title_mismatch' };
  const dates = findAnchoredDates(text, now);
  if (dates.length === 0) return { date: null, kind: 'no_date_found' };
  // Latest date wins (an "extended until" mention should beat an older
  // "until" mention still present elsewhere on the page).
  dates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { date: dates[0].date, quote: dates[0].quote };
}

module.exports = {
  extractWestEndClosingDate,
  extractWestEndClosingDateDetailed,
  pageMatchesShowTitle,
  findAnchoredDates,
  stripHtml,
};
