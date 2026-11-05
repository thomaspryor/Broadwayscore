'use strict';
/**
 * Is this paragraph site clutter (cookie banner, newsletter pitch, ad label),
 * or review prose? (BRO-6872)
 *
 * The old filters dropped ANY paragraph containing "subscribe", "sign up",
 * "cookie" or "newsletter". Critics use those words: Lighting & Sound
 * America's A Few Good Men review lost its closing paragraph to "subscribe",
 * and a Marines drama can say "sign up for" in every act. Clutter is short;
 * a long paragraph is dropped only when it carries an unmistakable promo phrase.
 *
 * Browser-side extractors (dom-article-extractor.js, page.evaluate blocks) run
 * serialized and cannot require this file: they inline the same rule and
 * tests/unit/chrome-paragraph.test.mjs checks they agree.
 */
const CHROME_PARAGRAPH_MAX_CHARS = 300;
const CHROME_WORDS = /cookie|subscribe|sign up|newsletter|advertisement/i;
const CHROME_PHRASES = /we use cookies|cookie (?:policy|settings|preferences)|subscribe to (?:our|the) (?:newsletter|mailing list)|sign up (?:for|to) (?:our|the) [\w' ]{0,40}newsletter|subscribe (?:now|today)\b/i;

function isChromeParagraph(text, extraWords = null) {
  const t = String(text || '').trim();
  if (CHROME_PHRASES.test(t)) return true;
  if (t.length >= CHROME_PARAGRAPH_MAX_CHARS) return false;
  return CHROME_WORDS.test(t) || Boolean(extraWords && extraWords.test(t));
}

module.exports = { isChromeParagraph, CHROME_PARAGRAPH_MAX_CHARS, CHROME_WORDS, CHROME_PHRASES };
