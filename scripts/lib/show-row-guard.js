/**
 * show-row-guard.js (BRO-5954)
 *
 * Pure validator for shows.json rows. Page generation dereferences a handful of
 * fields on every row (title.toLowerCase(), slugify(venue), toPostalAddress(venue)...).
 * One malformed row used to fail the whole static export (Other Desert Cities
 * night: prod deploys broken 6h44m by a null venue on one row). A row that fails
 * here is skipped and reported instead.
 *
 * Venue may legitimately be null before a show has a theater (announced/upcoming
 * rows, see BRO-5814), so null venue is only malformed once the show is past that.
 */

const PRE_THEATER_STATUSES = new Set(['announced', 'upcoming']);
const REQUIRED_STRING_FIELDS = ['id', 'title', 'slug', 'category', 'status'];

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Returns a list of problem strings for one row (empty list = row is fine). */
function validateShowRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return ['row is not an object'];
  }
  const problems = [];
  for (const f of REQUIRED_STRING_FIELDS) {
    if (!isNonEmptyString(row[f])) problems.push(`${f} is ${row[f] === null ? 'null' : row[f] === undefined ? 'missing' : 'not a non-empty string'}`);
  }
  const v = row.venue;
  if (v === undefined || v === null || v === '') {
    if (!PRE_THEATER_STATUSES.has(row.status)) problems.push(`venue is ${v === '' ? 'empty' : v === null ? 'null' : 'missing'} on a ${row.status} show`);
  } else if (typeof v !== 'string') {
    problems.push('venue is not a string');
  }
  return problems;
}

/** Splits rows into { valid, skipped: [{ id, index, problems }] }. Never throws. */
function partitionShowRows(rows) {
  const valid = [];
  const skipped = [];
  (Array.isArray(rows) ? rows : []).forEach((row, index) => {
    const problems = validateShowRow(row);
    if (problems.length === 0) valid.push(row);
    else skipped.push({ id: row && typeof row === 'object' && row.id ? String(row.id) : `(row ${index})`, index, problems });
  });
  return { valid, skipped };
}

function formatSkipped(skipped) {
  return skipped.map((s) => `${s.id}: ${s.problems.join('; ')}`);
}

module.exports = { validateShowRow, partitionShowRows, formatSkipped, PRE_THEATER_STATUSES };
