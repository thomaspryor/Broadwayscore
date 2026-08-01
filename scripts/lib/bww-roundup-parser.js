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

/**
 * Drop a block-boundary prefix from a captured byline.
 *
 * BWW's articleBody separates entries with a RUN of whitespace (4-5 spaces),
 * and the name pattern's `\s+` word separator spans it happily — so the last
 * word of the PRECEDING sentence gets absorbed as the next critic's first name.
 * Confirmed live 2026-08-01 against Review-Roundup-THE-COMEDY-ABOUT-SPIES-2026,
 * whose body reads "...Photo credit: Mark Senior     Franco Milazzo,
 * BroadwayWorld: ..." — the PHOTOGRAPHER's surname became the byline's first
 * word, and the pipeline persisted a phantom second BroadwayWorld critic
 * ("Senior     Franco Milazzo") on the-comedy-about-spies-west-end-2026. It
 * carried no URL, so same-URL dedup could not collapse it and the review was
 * double-counted. An archive sweep found 18 more: "Zimmerman  Jesse Green",
 * "Glikas  Jesse Green", "Murray  Alexander Cohen", "Brenner  Cindy Marcolina"
 * — all photo-credit surnames.
 *
 * Discriminator: a block boundary separates junk from a COMPLETE name, so the
 * tail after the run is itself >=2 words. A merely cosmetic double space inside
 * a real byline ("Peter  Marks", "Elisabeth  Vincentelli" in
 * the-addams-family-2010) leaves a 1-word tail — those must be kept intact.
 * Trimming on run-length alone silently deleted those three real critics, which
 * the archive parity run caught.
 */
function stripBlockBoundaryPrefix(raw) {
  if (!raw || !/\s{2,}/.test(raw)) return raw;
  const tail = raw.split(/\s{2,}/).pop();
  // Only treat the run as a block boundary when what follows still reads as a
  // full personal name (2+ words). Otherwise the run is intra-name whitespace.
  return /^\S+(\s+\S+)+$/.test(tail) ? tail : raw;
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
    const criticName = normalizeBylineCapture(stripBlockBoundaryPrefix(match[1].trim()));
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
