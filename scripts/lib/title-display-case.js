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
 *
 * ── Hardening pass, 2026-09-20 ────────────────────────────────────────────
 * The first cut shipped six real defects, every one of which would have put a
 * WRONG title in front of readers or wedged CI permanently. All six are now
 * covered by tests in title-display-case.test.mjs:
 *
 *  1. KEEP_UPPER held ordinary words. `us` and `la` are English/Spanish words
 *     far more often than initialisms in a show title, so `JUST FOR US`
 *     became "Just for US" and `MAN OF LA MANCHA` became "Man of LA Mancha".
 *     Both removed. A token only earns a KEEP_UPPER slot if it is never a
 *     plain word (see AMBIGUOUS_REJECTED below for the audit trail).
 *  2. Roman numerals were a partial hand-list, so `LOUIS XIV RETURNS` became
 *     "Louis Xiv Returns". Replaced with an explicit, validated set.
 *  3. A shouted title that converts to ITSELF (e.g. `BBC & RSC`, every token
 *     of which is a KEEP_UPPER acronym) made validate-data.js error forever
 *     with nothing the sweep could fix. `wouldChangeTitle()` is now the
 *     gate's condition, so "detected" and "actionable" are different
 *     questions and only the second one fails CI.
 *  4. There was no title-level exemption. KEEP_UPPER cannot suppress
 *     DETECTION, only re-uppercase a token, so a genuinely stylised
 *     multi-word title like `SIX THE MUSICAL` had no way to opt out short of
 *     raising minWords for everyone. KEEP_SHOUTED_IDS does that now.
 *  5. The letter class was Latin-1 only (`[A-Za-zÀ-ÿ]`), so Polish/Czech/
 *     Turkish titles corrupted rather than merely being skipped: `ŁÓDŹ BY
 *     NIGHT` came out "łÓdź by Night" — Ł and Ź fall outside the range, so
 *     they were lowercased by `.toLowerCase()` and then never re-capitalised.
 *     Everything is Unicode-aware (`\p{L}`/`\p{Lu}`/`\p{Ll}`) now. As a
 *     side-effect this also stops a CJK/Hebrew/Arabic title — which has no
 *     cased letters at all, so `letters === letters.toUpperCase()` was
 *     trivially TRUE — from being detected as shouted.
 *  6. The O'Neill rule fired on any single letter before an apostrophe, so
 *     `I'M STILL HERE` became "I'M Still Here". Only the real name prefixes
 *     (O', D', L') capitalise what follows.
 *
 * Two defects the same review ALLEGED are not real, verified against this
 * code before changing anything: `THE O'NEILL'S STORY` already produced
 * "The O'Neill's Story" (not "The O'Neill'S Story"), and a leading curly
 * quote already produced "“The Great Gatsby” Live". No change was made for
 * either; both are now pinned by tests so they stay fixed.
 */

'use strict';

// Words that stay lowercase inside a title, unless they're first or last or
// follow terminal punctuation. Standard AP-style minor words.
const MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
  'nor', 'of', 'off', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'up',
  'via', 'vs', 'with',
]);

// Tokens that must keep their exact shape — acronyms and initialisms.
// Checked case-insensitively against the raw token's letters.
//
// ADMISSION RULE, and it is strict: a token belongs here only if it is
// NEVER an ordinary word of English (or of a language that shows up in the
// corpus) in title position. We cannot consult context to decide, because
// by construction the ENTIRE title is uppercase — there is no mixed-case
// evidence anywhere in the string to disambiguate from. So an ambiguous
// token is always resolved as the ordinary word, which is the reading that
// is right far more often and, when wrong, is wrong in a way a reader
// forgives ("Just for Us") instead of one that looks like a bug
// ("Just for US").
const KEEP_UPPER = new Set([
  'nyc', 'usa', 'uk', 'tv', 'mtv', 'bbc', 'hbo', 'jfk', 'fbi',
  'cia', 'nasa', 'mlk', 'bff', 'diy', 'rsc', 'dc', 'ok',
]);

// Rejected from KEEP_UPPER by the rule above — kept as a comment so the next
// person does not "helpfully" re-add them:
//   us -> "JUST FOR US"      : the pronoun, not the country. Comedian Alex
//                              Edelman's show is "Just for Us".
//   la -> "MAN OF LA MANCHA" : the Spanish article, not Los Angeles.
//   i  -> "I AM MY OWN WIFE" : the pronoun; also a Roman numeral. The
//                              pronoun is handled for free (a lone "i" is a
//                              one-letter word and gets capitalised anyway).
const AMBIGUOUS_REJECTED = Object.freeze(['us', 'la', 'i']);

// Roman numerals that occur in real show titles (LOUIS XIV, HENRY VIII,
// ROCKY II, MALCOLM X, V FOR VENDETTA). Deliberately an explicit set and
// not a /^[IVXLCDM]+$/ regex: that regex also matches the ordinary English
// words MIX, DIM, DID, LID, MILL, CIVIL and CLIC, every one of which would
// then be shouted back at the reader. Single letters are included only
// where the letter is itself a plausible title token.
const ROMAN_NUMERALS = new Set([
  'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii',
  'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx', 'xxi',
]);

// Name prefixes where the letter AFTER the apostrophe is part of the name
// and gets capitalised: O'Neill, D'Angelo, L'Amour. Everything else before
// an apostrophe is a possessive or a contraction and stays lowercase, so
// KING'S -> King's and, critically, I'M -> I'm rather than I'M.
const NAME_PREFIXES = new Set(['o', 'd', 'l']);

// Titles this module must NOT auto-convert because the right answer is an
// editorial judgement, not a casing rule. Spanish-language titles are the
// live case: Spanish house style is sentence case ("Más sabe el saulo por
// viejo..."), not the English word-by-word title case this module applies,
// and guessing would ship a wrong-looking title to real readers. Flagged for
// a human instead — CLAUDE.md's "never guess or fake data".
const MANUAL_REVIEW_IDS = new Set([
  'mas-sabe-el-saulo-por-viejo-off-broadway-2025',
  // BRO-3915 2026-09-25: sources split, no decisive producer evidence.
  'the-listening-off-broadway-2026', // AKS og:title caps but AKS caps its own name (house style); Playbill "The Listening"
  'vida-off-broadway-2026',          // Repertorio caps is house style; Spanish press mostly "VIDA"
  'isla-off-broadway-2026',          // WP page unreachable; interview transcription "ISLA", TheaterMania "Isla"
]);

// Titles whose ALL-CAPS *is* the branding, where the 3-word minimum is not
// enough protection because a subtitle pushes a stylised short name over the
// threshold: "SIX THE MUSICAL" is three words but "SIX" is a trademark and
// "Six the Musical" is simply the wrong name. KEEP_UPPER cannot express this
// — it re-uppercases a TOKEN but cannot stop the title being DETECTED — so
// exemption is keyed by show id, the same way MANUAL_REVIEW_IDS is.
//
// Difference between the two sets: MANUAL_REVIEW_IDS means "a human still
// owes us a decision here" and is reported by the sweep as outstanding work;
// KEEP_SHOUTED_IDS means "decided, the caps are correct, never ask again"
// and is silent.
//
// BRO-3920 verification pass, 2026-09-20/21 — these two were reverted from
// the algorithm's guessed mixed case back to ALL-CAPS after checking the
// SOURCE's own structured metadata (JSON-LD `name` / og:title / <title>),
// not a rendered heading, per show:
//   god-is-a-woman-the-musical-off-west-end-2026 — King's Head Theatre's own
//     JSON-LD Event.name, og:title and <title> all agree: "GOD IS A WOMAN
//     THE MUSICAL". Luisa Omielan's own comedy-show branding.
//   this-is-not-about-me-* (both the OWE and the 59E59 OB transfer) — Soho
//     Theatre's own <title> tag AND TodayTix's <title> independently agree:
//     "THIS IS NOT ABOUT ME." (period included). No lowercase form of this
//     title exists in any source checked.
//
// noda-map-320f-west-end-2026 is NOT in this set, and that is a verified
// decision, not an oversight. A post-handoff review flagged it as suspect —
// the show's own reviewer described NODA・MAP as "always set in caps" and
// asked for a source check before either restoring ALL-CAPS here or
// confirming the stored "Noda Map – 320°F" as-is. Checked 2026-09-22:
// Sadler's Wells' own <title> tag AND og:title meta tag (raw HTML, not a
// rendered heading) both read "Noda Map - minus 320 Fahrenheit" — mixed
// case. The stored title is correct; no exemption needed.
const KEEP_SHOUTED_IDS = new Set([
  'god-is-a-woman-the-musical-off-west-end-2026',
  // BRO-3915 source pass, 2026-09-25 (venue/producer raw HTML + editorial
  // prose; venue all-caps HOUSE STYLE was checked and discounted):
  //   kenrex — production's own prose + Theatre Weekly/London Theatre running text "KENREX"
  //   care — Alexander Zeldin Company site "AZC — CARE" while its other titles are mixed case
  //   flyby — flybymusical.com og:title "FLYBY new musical..."
  //   yoah — New Victory/juggle.org prose "YOAH", character written "Yoah"
  //   jeezus — creator's own site "Their show JEEZUS! won..."
  //   360-allstars — Sadler's Wells og:title mixed-case company, caps title
  //   chat-noir — chatnoirlondon.com "CHAT NOIR!" beside mixed-case "Le Chat Noir"
  'kenrex-off-broadway-2026',
  'care-west-end-2026',
  'flyby-off-west-end-2026',
  'yoah-off-broadway-2026',
  'jeezus-off-west-end-2026',
  '360-allstars-off-west-end-2026',
  'chat-noir-off-west-end-2026',
  // Established stylised trademarks (handoff decision, not artifacts).
  'smash-2025', 'job-2024', 'kpop-2022', 'six-2021', 'qed-2001',
  'bigfoot-off-broadway-2026', 'kevin-off-broadway-2026',
]);

// The ingestion paths normalise a title BEFORE the row has an id — the id is
// DERIVED from the normalised title, so it cannot be an input to it. An
// id-keyed exemption is therefore invisible at exactly the moment it matters
// most: a brand-new Spanish ALL-CAPS title would be given guessed English
// casing on the way in, and the mixed-case result then evades detection
// forever. Both sets are mirrored by title so ingestion honours them too.
// (Adversarial review finding; confirmed by running the composer with a
// title and no id.)
const MANUAL_REVIEW_TITLES = new Set([]);
const KEEP_SHOUTED_TITLES = new Set([
  'this is not about me.',
]);

function titleKey(title) {
  return String(title || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function needsManualReview(showId, title) {
  if (showId && MANUAL_REVIEW_IDS.has(showId)) return true;
  return MANUAL_REVIEW_TITLES.has(titleKey(title));
}

function isExemptFromTitleCase(showId, title) {
  if (showId && KEEP_SHOUTED_IDS.has(showId)) return true;
  return KEEP_SHOUTED_TITLES.has(titleKey(title));
}

/**
 * Is this title all-caps in a way that indicates a scrape artifact rather
 * than a deliberate stylisation?
 *
 * Unicode-aware: a title is "shouted" only when it contains at least four
 * CASED letters and not one of them is lowercase. A script without case
 * (Chinese, Hebrew, Arabic, Japanese) therefore never qualifies, which is
 * the correct answer and was NOT what the Latin-1 version did.
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
  const upper = trimmed.match(/\p{Lu}/gu) || [];
  const lower = trimmed.match(/\p{Ll}/gu) || [];
  // Need enough cased letters to judge, and not one may be lowercase.
  if (upper.length < 4) return false;
  if (lower.length > 0) return false;
  return trimmed.split(/\s+/).length >= minWords;
}

// Capitalise one whitespace-delimited token, preserving internal punctuation.
// Splits on every alphabetic run so JEAN-MICHEL -> Jean-Michel and 320°F
// stays 320°F, and handles apostrophes so KING'S -> King's, I'M -> I'm and
// O'NEILL -> O'Neill.
function caseToken(token, { force }) {
  const bare = token.replace(/\P{L}/gu, '').toLowerCase();
  if (bare && (KEEP_UPPER.has(bare) || ROMAN_NUMERALS.has(bare))) return token.toUpperCase();
  if (!force && bare && MINOR_WORDS.has(bare)) return token.toLowerCase();

  // Capitalise the first letter of every ALPHABETIC RUN in the token, not
  // just after a hyphen: "320°F" must stay "320°F", not become "320°f"
  // (the degree sign is not a letter, so a hyphen-only rule left the F
  // lowercased — caught on NODA MAP – 320°F before any write landed).
  const lowered = token.toLowerCase();
  // Runs include combining MARKS, not just letters. Turkish is the case that
  // forces this: 'İ'.toLowerCase() is "i" + U+0307 COMBINING DOT ABOVE, so a
  // letters-only run stopped at the dot and the rest of the word started a
  // NEW run that got its own capital — İSTANBUL came out "İStanbul". The
  // NFC normalise in toDisplayTitleCase() then recomposes i+U+0307 back to
  // the precomposed U+0130.
  return lowered.replace(/[\p{L}\p{M}]+/gu, (run, offset) => {
    const prev = offset > 0 ? lowered[offset - 1] : '';
    if (prev === "'" || prev === '’') {
      // O'Hara / D'Angelo / L'Amour: a name prefix capitalises what follows.
      // Anything else before the apostrophe is a possessive (KING'S -> King's)
      // or a contraction (I'M -> I'm, IT'S -> It's) and stays lowercase.
      const before = lowered.slice(0, offset - 1);
      const priorRun = before.match(/[\p{L}\p{M}]+$/u);
      if (priorRun && priorRun[0].length === 1 && NAME_PREFIXES.has(priorRun[0])) {
        return run.charAt(0).toUpperCase() + run.slice(1);
      }
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
    // the title, so the NEXT word is force-capitalised: "...Mary: A Play...".
    // Trailing closing brackets/quotes are stripped first, so `(WHAT?)` and
    // `"ENOUGH!"` still count as terminal.
    const tail = tok.trim().replace(/[)\]}"'’”]+$/u, '');
    forceNext = /[:.?!—–|]$/.test(tail);
    return caseToken(tok, { force });
  }).join('')
    // Lowercasing a precomposed character can decompose it (U+0130 -> "i" +
    // U+0307). Recompose so the stored title is canonical NFC, which is what
    // the rest of the corpus is in and what title matching assumes.
    .normalize('NFC');
}

/**
 * Would conversion actually change this title? This — not isShoutedTitle() —
 * is what a CI gate must test.
 *
 * A title can be detected as shouted and still convert to itself: `BBC & RSC`
 * is three tokens, every letter uppercase, and every token is a KEEP_UPPER
 * acronym, so toDisplayTitleCase() returns it verbatim. Gating on detection
 * made validate-data.js emit an ERROR that the sweep script reported nothing
 * to fix — a permanently red build with no available action. Gate on this
 * instead.
 *
 * @returns {boolean}
 */
function wouldChangeTitle(title, opts = {}) {
  if (!isShoutedTitle(title, opts)) return false;
  return toDisplayTitleCase(title, opts) !== title;
}

/**
 * The single question every caller (sweep, gate, ingestion) should ask:
 * should this specific show's title be rewritten, and to what?
 *
 * @returns {{action:'convert'|'manual-review'|'none', title:string, from?:string}}
 */
function classifyShowTitle(showId, title, opts = {}) {
  if (!isShoutedTitle(title, opts)) return { action: 'none', title };
  if (isExemptFromTitleCase(showId, title)) return { action: 'none', title };
  if (needsManualReview(showId, title)) return { action: 'manual-review', title };
  const next = toDisplayTitleCase(title, opts);
  if (next === title) return { action: 'none', title };
  return { action: 'convert', title: next, from: title };
}

module.exports = {
  isShoutedTitle,
  needsManualReview,
  isExemptFromTitleCase,
  wouldChangeTitle,
  classifyShowTitle,
  MANUAL_REVIEW_IDS,
  KEEP_SHOUTED_IDS,
  MANUAL_REVIEW_TITLES,
  KEEP_SHOUTED_TITLES,
  toDisplayTitleCase,
  MINOR_WORDS,
  KEEP_UPPER,
  ROMAN_NUMERALS,
  AMBIGUOUS_REJECTED,
};
