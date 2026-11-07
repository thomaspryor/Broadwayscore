/**
 * Strict single-date extractor for the head of an article (BRO-4252). Full
 * month names only, exactly one non-run-date match in the first 500 chars,
 * else null.
 *
 * This was a second copy of body-date-mismatch.js's extractDateFromText, and
 * the copy kept a hard-coded 2027 year cap that the original had already
 * replaced with next-year (BRO-5261 S11). One parser now: the name stays for
 * the existing callers (backfill-text-dates.js, backfill-publish-date.js).
 */
const { extractDateFromText } = require('./body-date-mismatch');

module.exports = { extractSingleDate: extractDateFromText };
