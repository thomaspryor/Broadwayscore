/**
 * Display-case normalisation for show titles (BRO-3863).
 *
 * NOT to be confused with title-match.js's normalizeTitle(), which lowercases
 * and folds diacritics for MATCHING. This module is about how a title is
 * SHOWN to a reader.
 *
 * The problem: several ingestion paths read a title out of a heading that the
 * source site renders in CSS uppercase (`text-transform: uppercase`), so the
 * scraper captures the shouted form as if it were the real title. It then
 * ships verbatim to the site and the newsletter. Owner spotted it in the
 * 2026-09-20 Broadway round-up, where "AMERICA, WHO HURT YOU?" sat next to a
 * correctly-cased "The Cherry Orchard (Park Avenue Armory)"; Theatre for a
 * New Audience's own page writes it "America, Who Hurt You?".
 *
 * Provenance is mixed (press-listing-tfana-playbill, playbill-production-page,
 * venue-page:signature-theatre, Show-Score), so this is a shared normaliser
 * plus a validate-data gate rather than a fix to one scraper.
 *
 * DELIBERATELY CONSERVATIVE. Some titles really are all-caps and must not be
 * touched — SIX, POTUS, BLKS, FELA!, MJ. This only rewrites a title with
 * THREE OR MORE words, where the all-caps is essentially never a real
 * stylisation and always a scrape artifact. One- and two-word all-caps
 * titles are left alone; there are 23 of them in the corpus and they are
 * dominated by genuine stylisations.
 */

'use strict';

// Words that stay lowercase inside a title, unless they're first or last or
// follow terminal punctuation. Standard AP-style minor words.
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
  'nor', 'of', 'off', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'up',
  'via', 'vs', 'with',
]);

// Tokens that must keep their exact shape — acronyms, initialisms, numerals.
// Checked case-insensitively against the raw token's letters.
const KEEP_UPPER = new Set([
  'nyc', 'usa', 'uk', 'us', 'tv', 'mtv', 'bbc', 'hbo', 'ii', 'iii', 'iv',
  'vi', 'vii', 'viii', 'ix', 'xi', 'xii', 'dc', 'la', 'ok', 'jfk', 'fbi',
  'cia', 'nasa', 'mlk', 'bff', 'diy', 'rsc',
]);

// Titles this module must NOT auto-convert because the right answer is an
// editorial judgement, not a casing rule. Spanish-language titles are the
// live case: Spanish house style is sentence case ("Más sabe el saulo por
// viejo..."), not the English word-by-word title case this module applies,
// and guessing would ship a wrong-looking title to real readers. Flagged for
// a human instead — CLAUDE.md's "never guess or fake data".
const MANUAL_REVIEW_IDS = new Set([
  'mas-sabe-el-saulo-por-viejo-off-broadway-2025',
]);

function needsManualReview(showId) {
  return MANUAL_REVIEW_IDS.has(showId);
}

/**
 * Is this title all-caps in a way that indicates a scrape artifact rather
 * than a deliberate stylisation?
 *
 * @param {string} title
 * @param {{minWords?: number}} [opts] minWords defaults to 3 — see the
 *   module docstring for why one- and two-word titles are exempt.
 * @returns {boolean}
 */
function isShoutedTitle(title, opts = {}) {
  const minWords = opts.minWords ?? 3;
  if (typeof title !== 'string') return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  const letters = trimmed.replace(/[^A-Za-zÀ-ÿ]/g, '');
  // Need enough letters to judge, and every one of them must be uppercase.
  if (letters.length < 4) return false;
  if (letters !== letters.toUpperCase()) return false;
  return trimmed.split(/\s+/).length >= minWords;
}

// Capitalise one whitespace-delimited token, preserving internal punctuation.
// Splits on hyphens and slashes so JEAN-MICHEL -> Jean-Michel, and handles
// apostrophes so KING'S -> King's rather than King'S.
function caseToken(token, { force }) {
  const bare = token.replace(/[^A-Za-zÀ-ÿ]/g, '').toLowerCase();
  if (bare && KEEP_UPPER.has(bare)) return token.toUpperCase();
  if (!force && bare && MINOR_WORDS.has(bare)) return token.toLowerCase();

  // Capitalise the first letter of every ALPHABETIC RUN in the token, not
  // just after a hyphen: "320°F" must stay "320°F", not become "320°f"
  // (the degree sign is not a letter, so a hyphen-only rule left the F
  // lowercased — caught on NODA MAP – 320°F before any write landed).
  // A run preceded immediately by an apostrophe is the possessive/contraction
  // case and stays lowercase, so KING'S -> King's rather than King'S.
  const lowered = token.toLowerCase();
  return lowered.replace(/([a-zà-ÿ]+)/g, (run, _g, offset) => {
    const prev = offset > 0 ? lowered[offset - 1] : '';
    if (prev === "'" || prev === '\u2019') {
      // O'Hara / D'Angelo: a ONE-letter run before the apostrophe means a
      // name prefix, so capitalise. Otherwise it's a possessive -> leave it.
      const before = lowered.slice(0, offset - 1);
      const priorRun = before.match(/([a-zà-ÿ]+)$/);
      if (priorRun && priorRun[1].length === 1) return run.charAt(0).toUpperCase() + run.slice(1);
      return run;
    }
    return run.charAt(0).toUpperCase() + run.slice(1);
  });
}

/**
 * Convert a shouted title to display title case. Returns the input unchanged
 * when it isn't a shouted title, so this is safe to call unconditionally.
 *
 * @param {string} title
 * @param {{minWords?: number}} [opts]
 * @returns {string}
 */
function toDisplayTitleCase(title, opts = {}) {
  if (!isShoutedTitle(title, opts)) return title;

  const tokens = title.trim().split(/(\s+)/); // keep the whitespace runs
  const wordIdx = [];
  tokens.forEach((t, i) => { if (!/^\s+$/.test(t) && t) wordIdx.push(i); });

  const firstWord = wordIdx[0];
  const lastWord = wordIdx[wordIdx.length - 1];

  let forceNext = true; // first word is always capitalised
  return tokens.map((tok, i) => {
    if (/^\s+$/.test(tok) || !tok) return tok;
    const force = forceNext || i === firstWord || i === lastWord;
    // A token ending in terminal punctuation starts a new "sentence" inside
    // the title, so the NEXT word is force-capitalised: "...Mary: A Play..."
    forceNext = /[:.?!—–|]$/.test(tok.trim());
    const out = caseToken(tok, { force });
    // An opening bracket immediately before a minor word also forces it:
    // "(OF GOD)" -> "(of God)" reads wrong; theatre styling is "(of God)"
    // only when it's a parenthetical continuation, so leave brackets to the
    // minor-word rule and only force after terminal punctuation.
    return out;
  }).join('');
}

module.exports = {
  isShoutedTitle,
  needsManualReview,
  MANUAL_REVIEW_IDS,
  toDisplayTitleCase,
  MINOR_WORDS,
  KEEP_UPPER,
};
