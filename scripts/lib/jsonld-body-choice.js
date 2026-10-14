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

module.exports = { chooseArticleBody, SHORT_JSONLD_MAX, PARAGRAPH_RATIO, OPENING_CHARS };
