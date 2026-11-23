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

const norm = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');

/**
 * BRO-8211: a multi-critic Substack (The BroadGAYS) puts the PUBLICATION in the
 * byline/JSON-LD author, so every critic collapsed onto one file. True when the
 * extracted byline is the outlet's displayName, id or an alias.
 */
function isPublicationName(byline, outletEntry, outletId) {
  const b = norm(byline);
  if (!b) return false;
  const names = [outletEntry && outletEntry.displayName, outletId, ...((outletEntry && outletEntry.aliases) || [])];
  return names.some((n) => n && norm(n) === b);
}

/** Submitter-typed name: one line, 2-60 chars, not itself the publication. */
function cleanSubmitter(s) {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length >= 2 && v.length <= 60 && !isUnknown(v) ? v : '';
}

/**
 * "STEPHEN KEARLEY reviews CRAZY MAMA ..." (post title or opening line) names the
 * critic. Needs 2-4 name words so "Variety reviews" style leads never match.
 */
function criticFromReviewsTitle(...sources) {
  for (const src of sources) {
    const head = String(src || '').trim().slice(0, 200);
    const m = /^([A-Za-z][A-Za-z.'’-]*(?:\s+[A-Za-z][A-Za-z.'’-]*){1,3}?)\s+reviews\s+\S/i.exec(head);
    if (!m) continue;
    const name = m[1].trim();
    if (/^(the|a|an|our|my|we|critics?)\b/i.test(name)) continue;
    return name.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
  return null;
}

/**
 * @param {{criticArg?: string, lsaCritic?: string, byline?: string, stageCritic?: string, outletId?: string, submitterCritic?: string, pageTitle?: string, text?: string,
 *          outletEntry?: {defaultCritic?: string, multiAuthor?: boolean, standingCoverage?: boolean}}} p
 * @returns {string}
 */
function resolveCritic({ criticArg, lsaCritic, byline: rawByline, stageCritic, outletEntry, outletId, pageTitle, text, submitterCritic } = {}) {
  if (criticArg) return nameFromAuthorUrl(criticArg);
  if (lsaCritic) return lsaCritic;
  const canFill = shouldFillDefaultCritic(outletEntry);
  const dc = canFill ? String(outletEntry.defaultCritic).trim() : '';
  let byline = rawByline;
  if (byline && isPublicationName(nameFromAuthorUrl(byline), outletEntry, outletId)) {
    byline = cleanSubmitter(submitterCritic) || criticFromReviewsTitle(pageTitle, text) || '';
  }
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

module.exports = { resolveCritic, nameFromAuthorUrl, isPublicationName, criticFromReviewsTitle };
