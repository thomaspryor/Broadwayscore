'use strict';

/**
 * isPlaceholderByline(criticName, outlet)
 *
 * A byline is a placeholder — not a human critic identity — when scraper
 * extraction fell back to the outlet's own name, or to a generic desk/staff
 * label, instead of finding the actual writer. Card #1907 (2026-08-26): a
 * same-URL cluster where a placeholder survives as canonical alongside a real
 * byline double-counts the article (loves-labours-lost-globe-west-end-2026,
 * "The Times" vs "Clive Davis" — both files carried outlet "The Times (UK)").
 *
 * WHY criticName+outlet DATA FIELDS, not the filename slug: the pre-existing
 * isUnknownByline() in fix-circular-duplicate-pairs.js compares
 * bylineSlug(filename) to outletSlug(filename) — the filename PREFIX
 * (outletId, e.g. "times-uk"), not the outlet's display name ("The Times
 * (UK)"). A file named `times-uk--the-times.json` has slug "the-times" and
 * outletSlug "times-uk" — never equal, even though criticName "The Times"
 * IS the outlet display name. That mismatch is exactly why the loves-labours-
 * lost duplicate survived undetected. Reading the actual `criticName`/`outlet`
 * fields sidesteps outletId-vs-display-name drift entirely.
 */

// Bylines that carry no human identity regardless of outlet. Lowercase,
// space-normalized (matches normalizeForCompare's output).
const GENERIC_BYLINE_TERMS = new Set([
  'unknown', 'staff', 'staff writer', 'staff reporter', 'editor', 'editors',
  'editorial staff', 'editorial team', 'the editors', 'news desk', 'newsdesk',
  'bww news desk', 'admin', 'contributor', 'contributors', 'guest',
  'guest contributor', 'anonymous', 'team', 'review team', 'reviewer',
  'critic', 'theatre desk', 'theater desk', 'correspondent',
]);

/** Lowercase, strip parenthetical qualifiers ("(UK)"), collapse punctuation/whitespace. */
function normalizeForCompare(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * True when criticName is a placeholder rather than a real byline: empty,
 * purely numeric, a known generic desk/staff term, or the outlet's own name
 * (after normalization) with nothing else attached.
 * Pure — no I/O, safe for unit tests and use inside a canonical chooser.
 *
 * @param {string|null|undefined} criticName
 * @param {string|null|undefined} outlet display name (e.g. "The Times (UK)")
 * @returns {boolean}
 */
function isPlaceholderByline(criticName, outlet) {
  const norm = normalizeForCompare(criticName);
  if (!norm) return true;
  if (/^\d+$/.test(norm.replace(/\s+/g, ''))) return true;
  if (GENERIC_BYLINE_TERMS.has(norm)) return true;
  const normOutlet = normalizeForCompare(outlet);
  if (normOutlet && norm === normOutlet) return true;
  return false;
}

module.exports = { isPlaceholderByline, normalizeForCompare, GENERIC_BYLINE_TERMS };
