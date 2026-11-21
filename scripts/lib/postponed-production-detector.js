/**
 * postponed-production-detector.js (BRO-4913)
 *
 * Detects open/previews shows that are actually postponed: no reviews 48h+
 * past openingDate while the official/TodayTix page shows a FUTURE first-
 * performance date ("Coming to NYC January 28, 2027"). Pure functions so the
 * test exercises the real predicate (CLAUDE.md §15).
 *
 * Origin: magic-mike-live-new-york-off-broadway-2026 sat status:open from
 * 2026-10-08 though it had slipped to 2027-01-28 in July; the opening-night
 * monitor burned ~10 passes on a show that was not running.
 */
'use strict';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\.?';
// Cue words that mark a FIRST-performance / launch date, not a closing or
// mid-run date. A bare date with no cue is ignored (avoids "through June 27").
const CUE_RE = '(?:coming(?:\\s+(?:soon\\s+)?to\\s+[A-Za-z ]{2,30}?)?|opening\\s+(?:night|date)|premieres?|previews?\\s+(?:begin|start)|first\\s+performance|rescheduled\\s+(?:to|for)|postponed\\s+(?:to|until))';
const DATE_RE = new RegExp(
  `\\b${CUE_RE}[:,\\s-]{0,4}(?:on\\s+)?(?:\\w+day,?\\s+)?${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})`,
  'gi'
);

function monthIndex(token) {
  const t = token.toLowerCase().replace(/\./g, '');
  return MONTHS.findIndex(m => m.startsWith(t.slice(0, 3)));
}

/** @returns {string[]} ISO dates (YYYY-MM-DD) following a launch-cue phrase. */
function extractCuedDates(text) {
  const out = [];
  if (!text) return out;
  const re = new RegExp(DATE_RE.source, DATE_RE.flags);
  let m;
  const flat = String(text).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  while ((m = re.exec(flat)) !== null) {
    const mi = monthIndex(m[1]);
    if (mi < 0) continue;
    out.push(`${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`);
  }
  return out;
}

function hoursSince(dateStr, now) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  return Number.isNaN(t) ? null : (now.getTime() - t) / 3600000;
}

/**
 * @param {object} show shows.json entry
 * @param {{now: Date, reviewCount: number, pageText: string|null, graceHours?: number}} ctx
 * @returns {null | {futureDate: string, reason: string}}
 */
function evaluatePostponed(show, ctx) {
  if (!show || !['open', 'previews'].includes(show.status)) return null;
  if (ctx.reviewCount > 0 || !ctx.pageText || !show.openingDate) return null;
  const grace = ctx.graceHours == null ? 48 : ctx.graceHours;
  const since = hoursSince(show.openingDate, ctx.now);
  const maxDays = ctx.maxDaysPast == null ? 60 : ctx.maxDaysPast;
  // Long-running shows' pages carry unrelated future dates; only recent openings are suspects.
  if (since == null || since < grace || since > maxDays * 24) return null;
  const today = ctx.now.toISOString().slice(0, 10);
  const future = extractCuedDates(ctx.pageText).filter(d => d > today && d > show.openingDate).sort();
  if (future.length === 0) return null;
  return {
    futureDate: future[0],
    reason: `status ${show.status}, openingDate ${show.openingDate} passed ${Math.floor(since / 24)}d ago with 0 reviews, but official page shows future date ${future[0]}`,
  };
}

module.exports = { extractCuedDates, evaluatePostponed };
