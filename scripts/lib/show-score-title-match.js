/**
 * show-score-title-match.js: title helpers for scrape-show-score-audience.js, extracted so they can be tested
 * (CLAUDE.md §15). BRO-7357: the apostrophe classes used to read /['']/ (two ASCII quotes, the curly one lost
 * to an editor), so "It’s A Wonderful Life" never matched Show Score's "It's a Wonderful Life" and the page
 * was rejected as a title mismatch. Curly quotes are written as \u escapes so they cannot be flattened again;
 * tests/unit/flattened-apostrophe-class.test.mjs fails CI on any new /['']/-style class.
 */
'use strict';

const APOS = /['\u2018\u2019\u02BC]/g;

/** Slugify a show title for Show Score URL patterns. */
function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/&/g, '')           // Drop ampersand
    .replace(APOS, '-')          // Apostrophes (straight or curly) → hyphen
    .replace(/[:.!?,()]/g, '')   // Drop punctuation
    .replace(/\s+/g, '-')        // Spaces → hyphens
    .replace(/-+/g, '-')         // Collapse multiple hyphens
    .replace(/^-|-$/g, '');      // Trim leading/trailing hyphens
}

/** Normalize a title for fuzzy comparison (strip parenthetical suffixes, punctuation, etc.) */
function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/\s*\(broadway\)\s*/i, '')      // Strip "(Broadway)"
    .replace(/\s*\(london\)\s*/i, '')        // Strip "(London)"
    .replace(/\s*\(west end\)\s*/i, '')      // Strip "(West End)"
    .replace(/\s*\(.*?\)\s*$/, '')           // Strip trailing parenthetical
    .replace(APOS, '')                        // Strip apostrophes, straight or curly
    .replace(/["\u201C\u201D:,.!?]/g, '')    // Strip other punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a JSON-LD page title matches the show we're looking for.
 * Prevents listings-page contamination (where Hamilton appears as first result).
 */
function titlesMatch(jsonLdName, showTitle) {
  const a = normalizeTitle(jsonLdName);
  const b = normalizeTitle(showTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  // One contains the other (handles subtitles like "Sweeney Todd: The Demon Barber...")
  if (a.includes(b) || b.includes(a)) return true;
  // First significant word match (handles "The" prefix variations)
  const aWords = a.replace(/^the /, '').split(' ');
  const bWords = b.replace(/^the /, '').split(' ');
  if (aWords[0] === bWords[0] && aWords[0].length > 3) return true;
  return false;
}

module.exports = { slugifyTitle, normalizeTitle, titlesMatch };
