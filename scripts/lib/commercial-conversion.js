'use strict';
/**
 * A nonprofit's Broadway production that switched to a commercial run
 * (BRO-5508). The nonprofit plays its first weeks under the LORT contract; an
 * extension can continue as a commercial run with commercial producers and
 * investors, in the same theater (Lincoln Center Theater's Ragtime, from the
 * week of Jan 5, 2026) or after a move (Second Stage's Appropriate, from the
 * Hayes to the Belasco on Mar 25, 2024).
 *
 * commercial.json: "commercialConversion": { "date": "YYYY-MM-DD" | null, "sourceUrl": "https://..." }
 * date is the first day of the commercial run, null when the switch is
 * reported but its date is not. The record's capitalization is the commercial
 * run's money, nonprofitOrg the presenting company, and the designation a
 * commercial one (commercial-record-checks.js), so hasNoInvestorsToRepay
 * already reads it as having investors. The recoupment model does not model a
 * split run (recoupment-model.js): the nonprofit weeks, and often the
 * theater, belong to a different production.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const URL_RE = /^https?:\/\/\S+$/;

/** True for a YYYY-MM-DD string naming a real calendar day. */
function isCalendarDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * The record's switch to a commercial run, or null when it never switched.
 * A malformed date reads as not reported (null); the validator reports it.
 * @param {{ commercialConversion?: unknown } | null | undefined} rec
 * @returns {{ date: string | null, sourceUrl: string | null } | null}
 */
function conversionOf(rec) {
  const c = rec && rec.commercialConversion;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const { date, sourceUrl } = /** @type {{ date?: unknown, sourceUrl?: unknown }} */ (c);
  return {
    date: isCalendarDate(date) ? /** @type {string} */ (date) : null,
    sourceUrl: typeof sourceUrl === 'string' && URL_RE.test(sourceUrl) ? sourceUrl : null,
  };
}

/** @param {{ commercialConversion?: unknown } | null | undefined} rec */
function isConvertedToCommercial(rec) {
  return conversionOf(rec) !== null;
}

/**
 * The weekly rows of a run that switched which belong to its commercial run:
 * weeks ending after the switch date (a week ending on the switch day itself
 * was played on nonprofit terms). None when the date is not reported, since
 * the run cannot be split. Null for a record that never switched.
 * @template {{ week: string }} T
 * @param {{ commercialConversion?: unknown } | null | undefined} rec
 * @param {T[]} weeks - rows keyed by week-ending date (YYYY-MM-DD)
 * @returns {T[] | null}
 */
function commercialRunWeeks(rec, weeks) {
  const conversion = conversionOf(rec);
  if (!conversion) return null;
  const from = conversion.date;
  return from ? weeks.filter((r) => r.week > from) : [];
}

/**
 * Where a run's clock to recoupment starts: opening night, or for a run that
 * switched, the first day of its commercial run (its investors' money went in
 * then). Null when the switch date is not reported: counting from the
 * nonprofit opening would credit the commercial run with weeks it never had.
 * @param {{ commercialConversion?: unknown } | null | undefined} rec
 * @param {string | null | undefined} openingDate - the show's opening (YYYY-MM-DD)
 * @returns {string | null}
 */
function recoupClockStart(rec, openingDate) {
  const conversion = conversionOf(rec);
  if (!conversion) return openingDate || null;
  return conversion.date;
}

/**
 * Shape problems in a record's commercialConversion (empty when absent or
 * well formed). Cross-field rules live in commercial-record-checks.js.
 * @param {unknown} value
 * @returns {string[]}
 */
function conversionShapeProblems(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['must be an object { date, sourceUrl }'];
  const v = /** @type {Record<string, unknown>} */ (value);
  const out = [];
  if (v.date !== null && !isCalendarDate(v.date)) out.push(`date must be YYYY-MM-DD or null, got ${JSON.stringify(v.date)}`);
  if (typeof v.sourceUrl !== 'string' || !URL_RE.test(v.sourceUrl)) out.push('sourceUrl must be an http(s) URL');
  const extra = Object.keys(v).filter((k) => k !== 'date' && k !== 'sourceUrl');
  if (extra.length) out.push(`unknown keys: ${extra.join(', ')}`);
  return out;
}

module.exports = { conversionOf, isConvertedToCommercial, commercialRunWeeks, recoupClockStart, conversionShapeProblems };
