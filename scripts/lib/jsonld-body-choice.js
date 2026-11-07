'use strict';

const { decodeHtmlEntities } = require('./text-cleaning');
const { foldDiacritics } = require('./title-match');

/**
 * Pick between a JSON-LD articleBody and the page's own paragraph text.
 *
 * Some outlets publish only a teaser in JSON-LD while the full review is in
 * the page's <p> tags. Variety's 2007 "The Farnsworth Invention" review ships
 * a 621-char articleBody next to ~7.3k chars of article prose; taking the
 * JSON-LD first stored a 617-char "truncated" row (BRO-5222).
 *
 * JSON-LD stays the default (it avoids CSS-selector fragility). The paragraph
 * text wins only when the JSON-LD body is short, the paragraphs are more than
 * twice as long, AND the paragraphs contain the opening of the JSON-LD body.
 * A teaser is the start of the full text; sidebar or related-story cruft is
 * not, so a short real capsule review is never swapped for page chrome.
 */
const SHORT_JSONLD_MAX = 1500;
const PARAGRAPH_RATIO = 2;
const OPENING_CHARS = 150;

function normalizeForCompare(text) {
  return foldDiacritics(decodeHtmlEntities(String(text || '')))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function chooseArticleBody(jsonLdText, paragraphText) {
  const ld = jsonLdText || '';
  const ps = paragraphText || '';
  if (ld.length < SHORT_JSONLD_MAX && ps.length > ld.length * PARAGRAPH_RATIO) {
    const opening = normalizeForCompare(ld).slice(0, OPENING_CHARS).replace(/\s\S*$/, '');
    if (opening.length >= 40 && normalizeForCompare(ps).includes(opening)) {
      return { text: ps, source: 'paragraphs' };
    }
  }
  return { text: ld, source: 'jsonld' };
}

/**
 * A JSON-LD articleBody as prose. Some CMSs put markup in it; left in, the
 * stored text keeps raw tags and chooseArticleBody's length and same-opening
 * checks read tag text, so the teaser fallback never fires (Wayback
 * recovery, BRO-5261 retro-review of BRO-5222). Paragraph breaks are kept.
 * @param {*} articleBody
 * @returns {string}
 */
function jsonLdBodyToText(articleBody) {
  if (typeof articleBody !== 'string') return '';
  // Strip real tags BEFORE decoding, and only tag-shaped ones, so prose like
  // "3 &lt; 4 stars" or "I <3 this show" survives.
  return decodeHtmlEntities(articleBody
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote)>|<br\s*\/?>/gi, '\n\n')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n\s*\n */g, '\n\n')
    .trim();
}

module.exports = { chooseArticleBody, jsonLdBodyToText, SHORT_JSONLD_MAX, PARAGRAPH_RATIO, OPENING_CHARS };
