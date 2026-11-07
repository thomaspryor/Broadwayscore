'use strict';
/**
 * The "About the Show" blurb on a Show Score page (BRO-5859). Moved out of
 * scrape-show-score-audience.js, which cut it at 797 chars + "..." mid-word:
 * 49 shows.json synopses ended "...stars Patrick Page as Titus, one of
 * Shakespeare's most demanding tragic ro...". A long blurb is now cut at its
 * last sentence end inside the cap, never mid-word, never with an ellipsis.
 *
 * Pure, no I/O. scripts/lib/show-score-synopsis.test.mjs.
 */

const SHOW_SCORE_SYNOPSIS_MAX = 800;
// A full stop after an initial, a title, an abbreviation or a dotted acronym
// ("U.S.", "a.m.", "e.g.") is not a sentence end, nor is an ellipsis.
const NOT_A_SENTENCE_END = /(?:(?:^|[\s(])(?:[A-Z]|St|Mr|Mrs|Ms|Dr|Jr|Sr|vs|No|Mt|Inc|Co|Ltd|etc)|[A-Za-z]\.[A-Za-z]|\.)$/;

/**
 * `text` cut to at most `max` chars at its last sentence end, or null when the
 * first `max` chars hold no sentence end past 40% of the cap (a cut there would
 * leave a fragment). Text within the cap is returned unchanged.
 */
function capSynopsisAtSentence(text, max = SHOW_SCORE_SYNOPSIS_MAX) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (t.length <= max) return t;
  // Matched on the full text so a token straddling the cap ("3.5") is not a boundary.
  let end = -1;
  for (const m of t.matchAll(/[.!?]["'”’)\]]?(?=\s|$)/g)) {
    if (m.index + m[0].length > max) break;
    if (m[0][0] === '.' && NOT_A_SENTENCE_END.test(t.slice(0, m.index))) continue;
    end = m.index + m[0].length;
  }
  return end >= max * 0.4 ? t.slice(0, end) : null;
}

const paragraphsOf = (el) => Array.from(el.querySelectorAll('p'))
  .map((p) => (p.textContent || '').trim())
  .filter((t) => t.length > 10);

/**
 * Full (uncapped) About-the-Show text from a parsed Show Score document, or
 * null. Show Score: <div class="about-header"><h2>About the Show</h2></div>
 * followed by <div class="about"><p>...</p></div>.
 */
function extractShowScoreAboutText(doc) {
  for (const heading of doc.querySelectorAll('h2, h3')) {
    const headingText = (heading.textContent || '').trim().toLowerCase();
    if (headingText !== 'about the show' && headingText !== 'about this show') continue;
    const container = heading.parentElement;
    // 1: paragraphs in the heading's own parent
    if (container) {
      const texts = paragraphsOf(container);
      if (texts.length) return texts.join(' ').trim();
    }
    // 2: the parent's next siblings (Show Score's actual pattern)
    if (container) {
      let sib = container.nextElementSibling;
      for (let checked = 0; sib && checked < 3; checked++, sib = sib.nextElementSibling) {
        const texts = paragraphsOf(sib);
        if (texts.length) return texts.join(' ').trim();
        const sibText = (sib.textContent || '').trim();
        if (sibText.length > 20) return sibText;
      }
    }
    // 3: the heading's own next siblings, up to the next heading
    for (let sib = heading.nextElementSibling; sib; sib = sib.nextElementSibling) {
      if (sib.tagName && /^H[1-6]$/.test(sib.tagName)) break;
      const text = (sib.textContent || '').trim();
      if (text.length > 20) return text;
    }
    return null;
  }
  return null;
}

/** The synopsis to store from a Show Score page: About text capped at a sentence end. */
function extractShowScoreSynopsis(doc, max = SHOW_SCORE_SYNOPSIS_MAX) {
  return capSynopsisAtSentence(extractShowScoreAboutText(doc), max);
}

module.exports = { SHOW_SCORE_SYNOPSIS_MAX, capSynopsisAtSentence, extractShowScoreAboutText, extractShowScoreSynopsis };
