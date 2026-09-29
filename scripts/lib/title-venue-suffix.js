/**
 * Detect and strip a venue/producing-company name that a source site appended
 * to a show title as a disambiguating parenthetical (BRO-3863).
 *
 * THE BUG THE OWNER SAW
 * ---------------------
 * "many of the show names have their venue in them now? Park Avenue Armory and
 * Luna Stage, e.g. Why? Fix that too. I'm sure there are more."
 *
 * ROOT CAUSE
 * ----------
 * Show-Score's listing pages disambiguate same-title productions in their own
 * UI by appending the venue: "The Cherry Orchard (Park Avenue Armory)".
 * discover-new-shows.js took that display string as the title verbatim
 * (`title: candidate.title`, the Show-Score branch). Only the Playbill branch
 * ran any title normalisation at all. The suffix then flowed into `slug` and
 * `id`, so the artifact is visible in the row's identity too
 * (the-cherry-orchard-park-avenue-armory-off-broadway-2026).
 *
 * That it is a SOURCE artifact and not our own concatenation is provable from
 * the data: "Mrs. Stern Wanders the Prussian State Library (Luna Stage)" has
 * `venue: "59E59 Theaters (Theater A)"`. The venue in the title is the show's
 * ORIGINATING theatre in New Jersey, not where it is playing. No code of ours
 * could have produced that pairing; Show-Score's listing did.
 *
 * WHY STRIPPING IS SAFE EVEN WHEN IT CREATES A DUPLICATE TITLE
 * ------------------------------------------------------------
 * Eight of these collide with an existing show once the suffix is gone (four
 * other "The Cherry Orchard"s, two "Matilda The Musical"s, ...). Measured
 * against the corpus, a shared title is the NORMAL, DESIGNED state: 329
 * distinct titles are shared by 846 of 3,048 shows — Macbeth x8, Paranormal
 * Activity x8, Death of a Salesman x7 — and exactly ONE of those 329 groups
 * carries a trailing parenthetical. Disambiguation happens at render time
 * (venue, city, year, poster), never in the stored title. So the collisions
 * are not a reason to keep the suffix; they are the condition 846 shows
 * already live in.
 *
 * DETECTION — three oracles, union, because no single one is complete
 * -------------------------------------------------------------------
 *  1. own-venue   the parenthetical matches this show's own `venue` field.
 *                 Catches "(Park Avenue Armory)", "(BAM)", "(59e59)".
 *                 MISSES "(Luna Stage)", where the title names the show's
 *                 originating theatre and `venue` names the current one.
 *  2. corpus      the parenthetical matches some OTHER show's `venue`.
 *                 Catches a venue we know about from anywhere in the corpus.
 *                 MISSES a venue that appears nowhere else.
 *  3. keyword     the parenthetical contains a venue/company word
 *                 (Theatre, Playhouse, Armory, Stage, Company, ...).
 *                 Catches "(Luna Stage)" and "(The York Theatre Company)".
 *                 MISSES a bare proper noun like "(Bedlam)".
 *
 * The first cut of this audit used oracle 1 alone and reported 17 rows. That
 * undercounted: it silently classified "(Luna Stage)" — the example the owner
 * named by name — as "leave alone". The union finds 19.
 *
 * Oracles 1 and 2 match on TOKEN SEQUENCES, not substrings. "(Art)" must not
 * match a venue called "Hart Theatre" just because "hart" contains "art";
 * requiring a contiguous run of whole words makes "BAM" ⊂ "BAM Harvey
 * Theater" a hit and "art" ⊂ "hart" a miss.
 *
 * WHAT IS DELIBERATELY LEFT ALONE
 * --------------------------------
 * A trailing parenthetical is often part of the real title and stripping it
 * would destroy the name. All of these are in the corpus today and all are
 * correctly ignored, pinned by tests:
 *   "Two Strangers (Carry a Cake Across New York)"
 *   "Antigone (This Play I Read in High School)"
 *   "R.O.I (Return On Investment)"
 *   "My Son's A Queer (But What Can You Do?)"
 *   "The Body of Mary: A Play in Three Acts (of God)"
 *   "Rosie Jones: Anyone But Me (WIP)"
 *   "Escape: 6 Ways to Get Away (1)"
 * "Othello (Bedlam)" is a known miss — Bedlam is a producing company but also
 * an ordinary English word, and no oracle can tell those apart from the
 * string alone. The sweep reports it as a near-miss for a human rather than
 * guessing.
 */

'use strict';

// Whole words that mark a parenthetical as naming a venue or a producing
// company rather than being part of the title.
const VENUE_WORDS = [
  'theatre', 'theatres', 'theater', 'theaters', 'playhouse', 'playhouses',
  'armory', 'armoury', 'arena', 'auditorium', 'amphitheatre', 'amphitheater',
  'hall', 'pavilion', 'studio', 'studios', 'stage', 'stages', 'rep',
  'repertory', 'ensemble', 'workshop', 'barn', 'mill', 'centre', 'center',
  'company', 'troupe', 'collective', 'club', 'academy', 'conservatory',
  'opera', 'roundhouse', 'warehouse', 'bandshell', 'coliseum', 'colosseum',
];
const VENUE_WORD_RE = new RegExp(`(^|[^\\p{L}])(${VENUE_WORDS.join('|')})([^\\p{L}]|$)`, 'iu');

// A trailing parenthetical, with nothing nested inside it.
const TRAILING_PAREN_RE = /^(.*\S)\s*\(([^()]+)\)\s*$/;

// A parenthetical that OPENS with a function word is a continuation of the
// title, not a name: "(On Stage)", "(of God)", "(But What Can You Do?)",
// "(With a Song)". Only the venue-WORD oracle needs this guard — it is the
// weakest of the three, matching a bare vocabulary hit anywhere in the
// parenthetical, so without it "A Life (On Stage)" loses "(On Stage)" to the
// word "stage". The two venue-matching oracles are evidence-based (the string
// really is a venue we know about) and are not gated by it.
// Found by adversarial review, which produced exactly that example.
// ARTICLES ARE DELIBERATELY ABSENT. Venue and company names routinely begin
// with one — "The York Theatre Company", "The Old Vic", "A Contemporary
// Theatre" — so listing 'the'/'a'/'an' here would re-break the very rows
// this oracle exists to catch. Only prepositions and subordinating
// conjunctions, which turn the parenthetical into a phrase, belong.
const LEADING_FUNCTION_WORDS = new Set([
  'on', 'in', 'at', 'of', 'for', 'from', 'with', 'by', 'to', 'into', 'onto',
  'over', 'per', 'via', 'off', 'up', 'but', 'and', 'or', 'nor', 'as',
  'while', 'when', 'where', 'why', 'how', 'if', 'so', 'that', 'what', 'who',
  'plus', 'featuring', 'starring',
]);

// Shows whose trailing parenthetical is part of the real title and must
// never be stripped, even though an oracle fires on it. The caps case has
// the same escape hatch (KEEP_SHOUTED_IDS in title-display-case.js); without
// one here, validate-data.js would reject a title a human had deliberately
// restored and there would be no way to make the build green — the exact
// wedged-CI shape this work already had to fix once.
// Keyed by show id AND by title, because the ingestion paths normalise
// BEFORE an id exists (the id is derived from the normalised title).
const KEEP_PAREN_IDS = new Set([]);
const KEEP_PAREN_TITLES = new Set([]);

function titleKey(title) {
  return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Below this many characters a parenthetical is a disc/part number or a
// stray marker, never a venue name — and short strings are exactly where
// token matching produces coincidences.
const MIN_INNER_LENGTH = 3;

function tokens(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Is `needle`'s token sequence a contiguous run inside `haystack`'s?
function isTokenSubsequence(needle, haystack) {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

// Does the parenthetical open with a function word? See LEADING_FUNCTION_WORDS.
function startsWithFunctionWord(inner) {
  const first = (tokens(inner)[0] || '');
  return LEADING_FUNCTION_WORDS.has(first);
}

function venuesOverlap(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  return isTokenSubsequence(ta, tb) || isTokenSubsequence(tb, ta);
}

/**
 * Build the corpus-wide venue vocabulary (oracle 2) once, so callers sweeping
 * thousands of shows don't rebuild it per row.
 *
 * @param {Array<{venue?:string}>} shows
 * @returns {string[]}
 */
function buildVenueVocabulary(shows) {
  const seen = new Set();
  for (const s of shows || []) {
    const v = (s && s.venue) ? String(s.venue).trim() : '';
    if (v.length >= 4) seen.add(v);
  }
  return [...seen];
}

/**
 * Classify a title's trailing parenthetical.
 *
 * @param {string} title
 * @param {{venue?: string, venueVocabulary?: string[]}} [ctx]
 * @returns {{action:'strip'|'none', title:string, from?:string,
 *            suffix?:string, oracle?:'own-venue'|'corpus-venue'|'venue-word'}}
 */
function classifyVenueSuffix(title, ctx = {}) {
  if (typeof title !== 'string') return { action: 'none', title };
  if (ctx.id && KEEP_PAREN_IDS.has(ctx.id)) return { action: 'none', title };
  if (KEEP_PAREN_TITLES.has(titleKey(title))) return { action: 'none', title };
  const m = title.match(TRAILING_PAREN_RE);
  if (!m) return { action: 'none', title };

  const base = m[1].trim();
  const inner = m[2].trim();
  if (inner.length < MIN_INNER_LENGTH) return { action: 'none', title };
  // Never strip down to nothing, or to something that isn't a title.
  if (!base || !/\p{L}/u.test(base)) return { action: 'none', title };

  let oracle = null;
  if (ctx.venue && venuesOverlap(inner, ctx.venue)) {
    oracle = 'own-venue';
  } else if ((ctx.venueVocabulary || []).some(v => venuesOverlap(inner, v))) {
    oracle = 'corpus-venue';
  } else if (VENUE_WORD_RE.test(inner) && !startsWithFunctionWord(inner)) {
    oracle = 'venue-word';
  }
  if (!oracle) return { action: 'none', title };

  return { action: 'strip', title: base, from: title, suffix: inner, oracle };
}

/**
 * Convenience wrapper: returns the cleaned title, or the input unchanged.
 */
function stripVenueSuffix(title, ctx = {}) {
  return classifyVenueSuffix(title, ctx).title;
}

/**
 * Does this title still carry a venue suffix? This is the CI gate's question.
 */
function hasVenueSuffix(title, ctx = {}) {
  return classifyVenueSuffix(title, ctx).action === 'strip';
}

module.exports = {
  classifyVenueSuffix,
  stripVenueSuffix,
  hasVenueSuffix,
  buildVenueVocabulary,
  venuesOverlap,
  isTokenSubsequence,
  VENUE_WORDS,
  MIN_INNER_LENGTH,
  KEEP_PAREN_IDS,
  KEEP_PAREN_TITLES,
  LEADING_FUNCTION_WORDS,
  startsWithFunctionWord,
};
