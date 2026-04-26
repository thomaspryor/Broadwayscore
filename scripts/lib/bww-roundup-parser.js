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

const NAME_WORD = "[A-Z][a-zA-Z'’\\-]+";
// Single space between leading initial and first name. The lookbehind sits
// INSIDE the optional group so it only constrains the leading-initial branch:
// when no leading initial is present (the common case), the rest of the
// pattern is allowed to start right after a sentence-ending period (e.g.
// "...House.David Finkle, NYSR:"). When a leading initial IS present, the
// lookbehind blocks fragments like "World War II.", "U.K.", "AIDS.", "D.C."
// from being absorbed as the next critic's first initial.
const LEADING_INITIAL = "(?:(?<![A-Z.])[A-Z]\\. )?";
const MIDDLE_INITIAL = "(?:\\s+[A-Z]\\.?)?";
const NAME_CAPTURE = `${LEADING_INITIAL}${NAME_WORD}${MIDDLE_INITIAL}\\s+${NAME_WORD}(?:\\s+${NAME_WORD})?`;
// Lookahead is intentionally less greedy than the capture: it requires only
// the minimum 2-word name shape so the [^]+? quote ends at the EARLIEST plausible
// boundary. If the lookahead also allowed an optional 3rd word, "...Leap of
// Faith Joe Dziemianowicz, New York Daily News:" would let the previous quote
// end before "Faith" and the next match would absorb "Faith Joe Dziemianowicz"
// as one critic name. Mirrors the original two-word boundary pre-fix.
const NAME_LOOKAHEAD = `${LEADING_INITIAL}${NAME_WORD}${MIDDLE_INITIAL}\\s+${NAME_WORD}`;
const OUTLET = "[A-Za-z][A-Za-z\\s&'.]+";

const CRITIC_OUTLET_PATTERN = new RegExp(
  `(${NAME_CAPTURE}),\\s+(${OUTLET}):\\s*([^]+?)(?=(?:${NAME_LOOKAHEAD},\\s+${OUTLET}:)|Photo Credit:|$)`,
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
    const criticName = match[1].trim();
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
