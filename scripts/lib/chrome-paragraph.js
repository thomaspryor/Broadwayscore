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
 * The 300-char cutoff narrows the old bug; a short prose paragraph using one
 * of CHROME_WORDS is still dropped. CHROME_WORDS is the set the server readers
 * already used (no new words); readers that filtered more pass extraWords.
 *
 * Browser-side extractors run serialized and cannot require this file.
 * dom-article-extractor.js inlines CHROME_PHRASES verbatim (a drift test in
 * tests/unit/chrome-paragraph.test.mjs checks it) and keeps its own older word
 * list; the page.evaluate copies in collect-review-texts-v2 / collect-good-outlets /
 * collect-showscore-reviews inline only the 300-char guard on their old words.
 */
const CHROME_PARAGRAPH_MAX_CHARS = 300;
const CHROME_WORDS = /cookie|subscribe|sign up for|newsletter/i;
const CHROME_PHRASES = /(?:we|this (?:site|website)) uses? cookies|cookie (?:policy|settings|preferences)|subscribe to (?:our|the) (?:newsletter|mailing list)|sign up (?:for|to) [\w' ]{0,40}newsletter|subscribe (?:now|today)\b/i;

function isChromeParagraph(text, extraWords = null) {
  const t = String(text || '').trim();
  if (CHROME_PHRASES.test(t)) return true;
  if (t.length >= CHROME_PARAGRAPH_MAX_CHARS) return false;
  return CHROME_WORDS.test(t) || Boolean(extraWords && extraWords.test(t));
}

module.exports = { isChromeParagraph, CHROME_PARAGRAPH_MAX_CHARS, CHROME_WORDS, CHROME_PHRASES };
