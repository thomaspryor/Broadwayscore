/**
 * Pure critic resolution for ingest-review-from-url (BRO-4655).
 *
 * newyorktheater.me's WP byline is just "Jonathan"; the ingest used it as-is and
 * wrote nyt-theater--jonathan.json next to 378 nyt-theater--jonathan-mandell.json
 * files. A first-name-only byline that is the first token of the outlet's
 * registry defaultCritic is promoted to the full defaultCritic; an empty/Unknown
 * byline falls back to defaultCritic only for standingCoverage outlets.
 * multiAuthor outlets never get defaultCritic (shouldFillDefaultCritic).
 */
const { shouldFillDefaultCritic } = require('./critic-fill-rules');

const isUnknown = (s) => !s || /^unknown$/i.test(String(s).trim());

/**
 * An author-page URL ("https://www.broadwayworld.com/author/Gary-Naylor") is a
 * link to the critic, not their name: take the last path segment and
 * de-slugify it (BRO-4001). Anything else is returned unchanged.
 */
function nameFromAuthorUrl(s) {
  const m = /^(?:https?:)?\/\/[^/\s]+\/(?:[^\s?#]*\/)?authors?\/([^/\s?#]+)\/?(?:[?#]\S*)?$/i.exec(String(s || '').trim());
  if (!m) return s;
  let seg = m[1];
  try { seg = decodeURIComponent(seg); } catch { /* keep raw segment */ }
  // Only a slug that reads as a person (2+ alphabetic words, no digits/dots)
  // becomes a name; ids and handles stay as they were.
  const words = seg.split(/[-_+\s]+/).filter(Boolean);
  if (words.length < 2 || !words.every((w) => /^[A-Za-z'’]+$/.test(w))) return s;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * @param {{criticArg?: string, lsaCritic?: string, byline?: string, stageCritic?: string,
 *          outletEntry?: {defaultCritic?: string, multiAuthor?: boolean, standingCoverage?: boolean}}} p
 * @returns {string}
 */
function resolveCritic({ criticArg, lsaCritic, byline, stageCritic, outletEntry } = {}) {
  if (criticArg) return nameFromAuthorUrl(criticArg);
  if (lsaCritic) return lsaCritic;
  const canFill = shouldFillDefaultCritic(outletEntry);
  const dc = canFill ? String(outletEntry.defaultCritic).trim() : '';
  const b = byline ? String(nameFromAuthorUrl(byline)).trim() : '';
  if (b && !isUnknown(b)) {
    const tokens = b.split(/\s+/);
    if (dc && tokens.length === 1 && dc.split(/\s+/).length > 1 &&
        dc.split(/\s+/)[0].toLowerCase() === b.toLowerCase()) return dc;
    return b;
  }
  if (stageCritic) return stageCritic;
  if (dc && outletEntry.standingCoverage === true) return dc;
  return 'Unknown';
}

module.exports = { resolveCritic, nameFromAuthorUrl };
