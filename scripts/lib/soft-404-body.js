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

// BRO-7147: unlocker services (Bright Data) hand back a site's not-found
// template with HTTP 200 and full theme chrome (susanelkin.co.uk: "Page not
// found - Susan Elkin", 32 KB), so a length check takes it for the page and
// the archive.org fallback never runs. Judged on the <title> only, and only
// when one whole segment of it (split on the usual " - " / " | " separators)
// is a not-found phrase, so a show called "404" or a review headline that
// mentions a missing page does not trip it.
const NOT_FOUND_TITLE_SEGMENT = /^(?:(?:error\s*)?404\s*(?:error|page|not found|page not found)|error 404|page not found!?|nothing (?:was )?found|oops!? that page can(?:no|')t be found\.?|the page you requested (?:was|could) not (?:be )?found\.?)$/i;
// A bare "404" segment could be a show's name, so it counts only when the page
// itself also says it was not found.
const BARE_404_SEGMENT = /^404$/;
const NOT_FOUND_BODY = /\b(?:page not found|(?:can(?:no|')t|could not|couldn't) be found|does(?:n't| not) exist|no longer (?:exists|available)|nothing (?:was )?found)\b/i;

function htmlTitle(html) {
  // Only the document <title> in <head>: an inline <svg><title> is not the page title.
  const head = typeof html === 'string' ? (html.match(/<head[\s>][\s\S]*?<\/head>/i) || [html.split(/<body[\s>]/i)[0]])[0] : '';
  const m = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/&(?:#8217|#039|rsquo|apos);/gi, "'").replace(/&(?:#8211|#8212|ndash|mdash);/gi, '-').replace(/&(?:#124|vert);/gi, '|')
    .replace(/&[a-z0-9#]+;/gi, ' ').replace(/\s+/g, ' ').trim() : '';
}

/**
 * @param {string} html raw fetched page
 * @returns {boolean} true when the page is the site's not-found template
 */
function isNotFoundHtml(html) {
  const title = htmlTitle(html);
  if (!title) return false;
  const segs = title.split(/\s[-|:–—»·]\s|\s*\|\s*/).map((seg) => seg.trim());
  if (segs.some((seg) => NOT_FOUND_TITLE_SEGMENT.test(seg))) return true;
  return segs.some((seg) => BARE_404_SEGMENT.test(seg))
    && NOT_FOUND_BODY.test(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&rsquo;|&#8217;/g, "'"));
}

module.exports = { isSoft404Body, isNotFoundHtml, findDuplicateBodies, SOFT_404_MAX_LENGTH };
