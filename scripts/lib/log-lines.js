'use strict';

/**
 * log-lines.js — walk a large text (a GitHub Actions job log, gh output) one
 * line at a time without building a line array (BRO-6257).
 *
 * `text.split('\n')` on a job log of tens of MB (gh's maxBuffer is 64 MB)
 * allocates one string per line plus the array at once, and `.map()` over it
 * doubles that. wait-for-land.js died in Runtime_StringSplit that way on
 * 2026-10-25 (BRO-6040 recurrence). Here each line is a short-lived slice,
 * and a caller can stop as soon as it has its answer.
 *
 * forEachLine(text, fn, { maxLineLength }) calls fn(line, index, truncated)
 * for every '\n'-separated line (a trailing '\n' yields a final '' line, as
 * split does). Lines longer than maxLineLength are cut to that length and
 * flagged truncated, so one huge line never gets copied whole. fn returning
 * true stops the walk; forEachLine then returns true, else false.
 */
const DEFAULT_MAX_LINE = 64 * 1024;

function forEachLine(text, fn, { maxLineLength = DEFAULT_MAX_LINE } = {}) {
  const s = String(text || '');
  for (let start = 0, n = 0; ; n += 1) {
    const nl = s.indexOf('\n', start);
    const end = nl === -1 ? s.length : nl;
    const truncated = end - start > maxLineLength;
    if (fn(s.slice(start, truncated ? start + maxLineLength : end), n, truncated) === true) return true;
    if (nl === -1) return false;
    start = nl + 1;
  }
}

// First line of a message that may hold a whole API response or log (an
// execFileSync error carries stderr): bound the prefix before looking for a
// newline, so logging never allocates a line array for the full body (BRO-6040).
function firstLine(value, max = 500) {
  const prefix = String(value || '').slice(0, max);
  const newline = prefix.indexOf('\n');
  return newline === -1 ? prefix : prefix.slice(0, newline);
}

// A slice or regex match of a big string is a V8 SlicedString that keeps the
// WHOLE parent alive. land-run-identity caches identities from every Checks
// log it reads (~15 MB each, 2026-10-26), so a cached 40-char SHA pinned its
// whole log and a hand-dispatch-heavy history OOMed wait-for-land.js
// (BRO-6257). Copy any value that outlives the text it was parsed from.
function detach(value) {
  return value == null ? value : Buffer.from(String(value), 'utf8').toString('utf8');
}

module.exports = { forEachLine, firstLine, detach, DEFAULT_MAX_LINE };
