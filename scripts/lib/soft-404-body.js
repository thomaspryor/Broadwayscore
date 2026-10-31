/**
 * Generic soft-404 detector for review-text bodies (BRO-3116).
 *
 * A soft-404 is a page served with HTTP 200 whose body is the site's
 * "not found" template. Before this guard the collector wrote that chrome to
 * data/review-texts/<show>/<outlet>--<critic>.json as fullText, so the file
 * looked handled and the real review published at the same URL hours later was
 * never re-fetched (jane-eyre-off-west-end-2026, London Box Office).
 *
 * Pure functions only; the collector, the backfill scan and the tests all
 * require() this file.
 */

// Strong: wording only a site's error template uses.
const STRONG_SIGNATURES = [
  /\bdocument not found\b/i,
  /\bthe document you are looking for does not exist\b/i,
  /\bthe page you (?:are|were) looking for (?:does not exist|could not be found|can(?:no|')t be found|is no longer available)\b/i,
  // McClatchy (Tacoma News Tribune / AP syndication) template; shipped as
  // the-nance-2013 AP's pull quote via raw-fullText extraction (2026-10-19).
  /\bwe are unable to locate the page you requested\b/i,
];
// Weak: phrases a short real review can contain ("page not found" joke, a
// show with 404 in its title). Count only alongside site-nav chrome.
const WEAK_SIGNATURES = [
  /\bpage not found\b/i,
  /\b404\s*(?:-|:)?\s*(?:error|not found)\b/i,
];
const NAV_CHROME = [/\bhome\b/i, /\bsearch\b/i, /\bmenu\b/i, /\bsubscribe\b/i, /\bsign in\b/i, /\bcontact\b/i, /\blatest news\b/i, /\bprivacy\b/i];
const WEAK_MAX_LENGTH = 1200;

// A real review is long. A not-found template wrapped in site nav is short
// (870 chars for London Box Office). Above this length a "page not found"
// phrase is more likely an incidental quote inside an article.
const SOFT_404_MAX_LENGTH = 2500;

/**
 * @param {string} text fetched body
 * @returns {boolean}
 */
function isSoft404Body(text) {
  if (typeof text !== 'string') return false;
  const body = text.trim();
  if (!body || body.length > SOFT_404_MAX_LENGTH) return false;
  if (STRONG_SIGNATURES.some((re) => re.test(body))) return true;
  if (body.length > WEAK_MAX_LENGTH || !WEAK_SIGNATURES.some((re) => re.test(body))) return false;
  return NAV_CHROME.filter((re) => re.test(body)).length >= 2;
}

function normUrl(u) {
  return typeof u === 'string'
    ? u.trim().toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '')
    : '';
}

/**
 * Groups of review files within ONE show whose non-trivial bodies are
 * byte-identical (the same chrome fetched for different critics/URLs).
 *
 * @param {Array<{file: string, fullText?: string, url?: string}>} entries files of one show
 * @param {number} [minLength=200] ignore bodies shorter than this (and, since
 *   site chrome is short, bodies longer than SOFT_404_MAX_LENGTH)
 * @returns {string[][]} arrays of file names, each with 2+ members
 */
function findDuplicateBodies(entries, minLength = 200) {
  const byBody = new Map();
  for (const e of entries || []) {
    const t = typeof e.fullText === 'string' ? e.fullText.trim() : '';
    if (t.length < minLength || t.length > SOFT_404_MAX_LENGTH) continue;
    if (!byBody.has(t)) byBody.set(t, []);
    byBody.get(t).push(e.file);
  }
  // Two critics on the SAME url legitimately share one article body (joint
  // bylines, duplicate rows); only distinct URLs serving one body are chrome.
  const urlOf = new Map((entries || []).map((e) => [e.file, normUrl(e.url) || e.file]));
  return [...byBody.values()].filter((g) => new Set(g.map((f) => urlOf.get(f))).size > 1);
}

module.exports = { isSoft404Body, findDuplicateBodies, SOFT_404_MAX_LENGTH };
