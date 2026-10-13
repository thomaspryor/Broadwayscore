'use strict';

/**
 * Pick between a JSON-LD articleBody and the page's own paragraph text.
 *
 * Some outlets publish only a teaser in JSON-LD while the full review is in
 * the page's <p> tags. Variety's 2007 "The Farnsworth Invention" review ships
 * a 621-char articleBody next to ~9.8k chars of article prose; taking the
 * JSON-LD first stored a 617-char "truncated" row (BRO-5222).
 *
 * JSON-LD stays the default (it avoids CSS-selector fragility). The paragraph
 * text wins only when the JSON-LD body is short and the paragraphs are more
 * than twice as long, so sidebar cruft cannot outvote a real full body.
 */
const SHORT_JSONLD_MAX = 1500;
const PARAGRAPH_RATIO = 2;

function chooseArticleBody(jsonLdText, paragraphText) {
  const ld = jsonLdText || '';
  const ps = paragraphText || '';
  if (ld.length < SHORT_JSONLD_MAX && ps.length > ld.length * PARAGRAPH_RATIO) {
    return { text: ps, source: 'paragraphs' };
  }
  return { text: ld, source: 'jsonld' };
}

module.exports = { chooseArticleBody, SHORT_JSONLD_MAX, PARAGRAPH_RATIO };
