/**
 * bww-roundup-parser.js — extract "Critic, Outlet:" pairs from BWW Review Roundup articleBody.
 *
 * Inline regex previously lived in gather-reviews.js (Method 2 path) and a tighter
 * variant in extract-bww-reviews.js. The first-word slot did not allow a leading
 * single-letter initial, so "J. Kelly Nestruck, The Globe and Mail: ..." was
 * captured as "Kelly Nestruck" — silently dropping the "J." byline. The same
 * pattern affected at least one Globe and Mail roundup entry in production data
 * (the-prom-2018, paradise-square-2022, beautiful-the-carole-king-musical-2014,
 * proof-2026). See feedback_critic_name_initial_truncation.md.
 *
 * The leading-initial slot is `(?:[A-Z]\.\s+)?` — it captures one initial+dot
 * followed by whitespace. Names like "K.T. Sullivan" (no space between initials)
 * remain unhandled by design — adding multi-initial support invites broader
 * false positives and they don't appear in the current corpus.
 */

const { normalizeBylineCapture } = require('./byline-normalization');

const NAME_WORD = "[A-Z][a-zA-Z'’\\-]+";
// Single space between leading initial and first name. The lookbehind sits
// INSIDE the optional group so it only constrains the leading-initial branch:
// when no leading initial is present (the common case), the rest of the
// pattern is allowed to start right after a sentence-ending period (e.g.
// "...House.David Finkle, NYSR:"). When a leading initial IS present, the
// lookbehind blocks fragments like "World War II.", "U.K.", "AIDS.", "D.C."
// from being absorbed as the next critic's first initial.
const LEADING_INITIAL = "(?:(?<![A-Z.])[A-Z]\\. )?";
const WORD_SEP = "\\s+";
const MIDDLE_INITIAL = `(?:${WORD_SEP}[A-Z]\\.?)?`;
const NAME_CAPTURE = `${LEADING_INITIAL}${NAME_WORD}${MIDDLE_INITIAL}${WORD_SEP}${NAME_WORD}(?:${WORD_SEP}${NAME_WORD})?`;
// Same shape as NAME_CAPTURE but anchored — "is this string, entire, a byline?"
const WHOLE_NAME_RE = new RegExp(`^${NAME_CAPTURE}$`);

// A byline always begins at an ENTRY boundary. BWW's articleBody separates
// entries with a RUN of 2+ whitespace, so that run — not the regex's own match
// start — is the authoritative anchor for where a critic's name begins.
const BLOCK_SEPARATOR = /\s{2,}/g;

/**
 * Re-anchor a captured byline to its entry boundary.
 *
 * Two independent failures both come from trusting the regex's match start:
 *
 *  1. OVER-CAPTURE — `\s+` between name words spans the entry separator, so the
 *     last word of the PRECEDING sentence is absorbed as the critic's first
 *     name. Confirmed live 2026-08-01 on Review-Roundup-THE-COMEDY-ABOUT-SPIES-2026:
 *     "...Photo credit: Mark Senior     Franco Milazzo, BroadwayWorld: ..." made
 *     the PHOTOGRAPHER's surname the byline's first word, minting a phantom
 *     second BroadwayWorld critic ("Senior     Franco Milazzo") with no URL —
 *     so same-URL dedup could not collapse it and the review double-counted.
 *     An archive sweep found 18 more ("Zimmerman  Jesse Green", "Glikas  Jesse
 *     Green", "Murray  Alexander Cohen"), all photo-credit surnames.
 *
 *  2. UNDER-CAPTURE — NAME_LOOKAHEAD is deliberately 2 words (see its comment),
 *     so for a THREE-word byline the preceding quote stops one word late and the
 *     next match starts mid-name. "Melissa Rose Bernardo, New York Stage Review"
 *     parsed as "Rose Bernardo" on chess-2025, chess-1988 and
 *     real-women-have-curves-2025 — a wrong critic name, and a wrong filename
 *     slug on any file written from it.
 *
 * Anchoring on the separator fixes both: take the text from the end of the last
 * 2+ whitespace run before the comma, and use it when it is itself a complete
 * name. A merely cosmetic double space INSIDE a real byline ("Peter  Marks",
 * "Elisabeth  Vincentelli" in the-addams-family-2010) leaves a 1-word remainder,
 * which fails the whole-name test, so the original capture is kept and
 * normalizeBylineCapture collapses its whitespace.
 *
 * @param {string} text - the body being scanned
 * @param {number} nameStart - index where the regex began its name capture
 * @param {string} captured - the raw capture group
 * @returns {string} the entry-anchored name, or `captured` when no boundary applies
 */
function anchorNameToEntryBoundary(text, nameStart, captured) {
  if (!captured) return captured;
  const nameEnd = nameStart + captured.length;
  // Look BACK past the capture start, not just inside it. The separator sits
  // before the capture in the under-capture case (the 2-word lookahead started
  // the match mid-name) and inside it in the over-capture case. LOOKBACK_CHARS
  // bounds the scan: a byline is at most 3 words, so a separator farther back
  // than this could only yield a candidate that WHOLE_NAME_RE rejects anyway.
  const LOOKBACK_CHARS = 100;
  const windowStart = Math.max(0, nameStart - LOOKBACK_CHARS);
  const segment = text.slice(windowStart, nameEnd);
  BLOCK_SEPARATOR.lastIndex = 0;
  let lastSepEnd = -1;
  let m;
  while ((m = BLOCK_SEPARATOR.exec(segment)) !== null) {
    lastSepEnd = m.index + m[0].length;
  }
  if (lastSepEnd === -1) return captured;
  const candidate = segment.slice(lastSepEnd).trim();
  // Only re-anchor when what follows the separator is a complete name on its
  // own. Otherwise the run was intra-name whitespace, not an entry boundary.
  return WHOLE_NAME_RE.test(candidate) ? candidate : captured;
}
// Lookahead is intentionally less greedy than the capture: it requires only
// the minimum 2-word name shape so the [^]+? quote ends at the EARLIEST plausible
// boundary. If the lookahead also allowed an optional 3rd word, "...Leap of
// Faith Joe Dziemianowicz, New York Daily News:" would let the previous quote
// end before "Faith" and the next match would absorb "Faith Joe Dziemianowicz"
// as one critic name. Mirrors the original two-word boundary pre-fix.
const NAME_LOOKAHEAD = `${LEADING_INITIAL}${NAME_WORD}${MIDDLE_INITIAL}${WORD_SEP}${NAME_WORD}`;
const OUTLET = "[A-Za-z][A-Za-z\\s&'.]+";
// BWW's CMS emits a stray space before the comma on some entries — the live
// SPIES-2026 body carries "Ryan Gilbey , The Guardian:" and
// "Holly O'Mahony , The Stage:" alongside comma-tight siblings. The old
// name-then-literal-comma pattern silently dropped BOTH of those critics (6 of
// 8 parsed). `\s*` before the comma is safe: NAME_CAPTURE cannot end mid-word,
// so nothing new can be absorbed.
const PRE_COMMA = "\\s*";
// Terminator for the LAST critic's quote. BWW writes "Photo credit:" (lower-case
// c); the old literal "Photo Credit:" never matched, so a trailing photo credit
// was swallowed into the final quote. Match either casing, singular or plural.
const TAIL_TERMINATOR = "[Pp]hoto [Cc]redits?:";

const CRITIC_OUTLET_PATTERN = new RegExp(
  `(${NAME_CAPTURE})${PRE_COMMA},\\s+(${OUTLET}):\\s*([^]+?)(?=(?:${NAME_LOOKAHEAD}${PRE_COMMA},\\s+${OUTLET}:)|${TAIL_TERMINATOR}|$)`,
  'g'
);

/**
 * Extract critic/outlet/excerpt triples from a BWW Review Roundup articleBody.
 * Caller is responsible for outlet normalization and dedup.
 *
 * @param {string} articleBody - raw articleBody string from BWW JSON-LD
 * @returns {Array<{criticName: string, outletRaw: string, quote: string}>}
 */
function parseArticleBodyReviews(articleBody) {
  if (!articleBody) return [];

  const reviewStart = articleBody.indexOf("Let's see what the critics had to say");
  const text = reviewStart > 0 ? articleBody.substring(reviewStart) : articleBody;

  const out = [];
  const seen = new Set();
  CRITIC_OUTLET_PATTERN.lastIndex = 0;
  let match;
  while ((match = CRITIC_OUTLET_PATTERN.exec(text)) !== null) {
    // Route through the shared byline normalizer (collapses internal whitespace,
    // strips page-chrome tokens, title-cases ALL-CAPS bylines) so this parser
    // can never be the origin of a raw-capture criticName. Previously the
    // roundup path was the ONE byline writer that bypassed it.
    const criticName = normalizeBylineCapture(
      anchorNameToEntryBoundary(text, match.index, match[1])
    );
    const outletRaw = match[2].trim();
    const quote = match[3].trim();

    if (outletRaw.length < 2 || outletRaw.length > 60) continue;
    if (/^(In|The|A|An|On|At|For|With|And|But|Or|If|So|As|By)$/i.test(outletRaw)) continue;

    const key = `${criticName.toLowerCase()}|${outletRaw.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ criticName, outletRaw, quote });
  }
  return out;
}

module.exports = {
  parseArticleBodyReviews,
  CRITIC_OUTLET_PATTERN,
};
