/**
 * show-title-match.js
 *
 * One title-confirmation guard for the closing-date audits (BRO-4753).
 * audit-closing-dates.js, closing-date-discovery.js and
 * we-closing-date-extract.js each carried their own copy of "page mentions
 * any >=4-char word of the title" with a raw substring test. On a broadway.com
 * 404 for the wrong slug, the title "School Girls; Or, The African Mean Girls
 * Play" matched because the page's inline JS contains "display": the audit
 * then read the 404 as an empty schedule and filed a POSSIBLY-CLOSED card for
 * a running show.
 *
 * Rules: script/style blocks never count, a word must match whole, and
 * generic theatre words (play, musical, show, broadway...) count only when
 * the title has no distinctive word at all.
 */

const GENERIC_WORDS = new Set([
  'play', 'plays', 'musical', 'musicals', 'show', 'shows', 'broadway',
  'theatre', 'theater', 'live', 'story', 'with', 'from', 'into', 'this',
  'that', 'your', 'what', 'when', 'where', 'there', 'their', 'about',
  'after', 'over', 'under', 'part', 'parts', 'tour', 'concert',
]);

function stripToText(html) {
  return String(html || '')
    .replace(/<script[^]*?<\/script>/gi, ' ')
    .replace(/<style[^]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWord(haystack, word) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`).test(haystack);
}

/**
 * @param {string} htmlOrText - page HTML or already-stripped text
 * @param {string} showTitle
 * @returns {boolean} true when the page names the show
 */
function pageMatchesShowTitle(htmlOrText, showTitle) {
  if (!htmlOrText || !showTitle) return false;
  const haystack = stripToText(htmlOrText);
  const tokens = showTitle.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const long = tokens.filter(w => w.length >= 4);
  const distinctive = long.filter(w => !GENERIC_WORDS.has(w));
  // Short titles ("Job") fall back to any whole token; all-generic titles
  // ("The Play") fall back to their generic words.
  const words = distinctive.length ? distinctive : (long.length ? long : tokens);
  return words.some(w => hasWord(haystack, w));
}

module.exports = { pageMatchesShowTitle, stripToText, GENERIC_WORDS };
