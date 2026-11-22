/**
 * The one place that answers "what should this show's stored title be?"
 * (BRO-3863).
 *
 * Two independent scrape artifacts corrupt stored titles:
 *
 *   1. a venue/company appended by the source as a disambiguator
 *      ("The Cherry Orchard (Park Avenue Armory)")    -> title-venue-suffix.js
 *   2. a heading captured from a source that doesn't preserve true casing
 *      ("AMERICA, WHO HURT YOU?")                     -> title-display-case.js
 *   3. a Roman numeral title-cased by slug capitalising
 *      ("Richard Ii", BRO-4567)                       -> title-display-case.js
 *
 * BRO-3920 retired algorithmic title-casing as a fix for (2): guessing a
 * casing from the shouted string alone already shipped wrong output
 * ("JUST FOR US" -> "Just for US", "MAN OF LA MANCHA" -> "Man of LA
 * Mancha"). The only trustworthy fix is re-deriving the title from the
 * source's structured metadata (JSON-LD `name` / `og:title`), which is an
 * ingestion-side concern, not something this normaliser can do after the
 * fact from the string alone. So step 2 here is DETECTION ONLY: it flags a
 * shouted title as needing a human to look up the source and either correct
 * the stored title or, if the caps are genuinely correct branding, add the
 * show id to KEEP_SHOUTED_IDS (title-display-case.js). It never rewrites.
 *
 * The venue-suffix step (1) is unaffected — stripping a known, matched venue
 * name is a deterministic transform, not a guess.
 *
 * ORDER MATTERS, and the corpus proves it. "THIS IS NOT ABOUT ME. (59E59
 * Theaters)" is NOT detected as shouted, because "Theaters" inside the
 * parenthetical supplies lowercase letters. Strip the venue first and
 * "THIS IS NOT ABOUT ME." is plainly shouted. Run the detector first and it
 * never fires. So: venue suffix, THEN shouted-casing detection.
 *
 * Every caller — the ingestion path in discover-new-shows.js, the corpus
 * sweep in fix-show-titles.js, and the validate-data.js gate — goes through
 * this function, so the audit, the guard and the writer can never disagree
 * about what a correct title is. That equivalence is the whole point; see
 * memory/feedback_includability_predicates_must_be_canonical.md.
 */

'use strict';

const { classifyVenueSuffix, buildVenueVocabulary } = require('./title-venue-suffix');

// A title with more trailing parentheticals than this is not a title.
const MAX_VENUE_STRIP_PASSES = 4;
// "(musical)", "(play)", "(opera)" as the WHOLE trailing parenthetical only.
// "Matilda The Musical" and "Rock of Ages (The Musical Comedy)" are untouched.
const GENRE_DISAMBIGUATOR_RE = /\s*\((?:musical|play|opera)\)\s*$/i;
// BRO-7156: a feed's internal listing name with the season glued on by an
// underscore (TodayTix 47136 "Berlin_2027", Kiln Theatre). No real title ends
// in "_<year>"; the id/slug carry the year.
const LISTING_YEAR_SUFFIX_RE = /_(?:19|20)\d{2}$/;
// BRO-8051: trailing " by <Full Name>" playwright credit appended by a feed
// (TIC: "Engines and Instruments of Flight: A Fantasia in Three Acts by Calamity West").
// Pure regex is FP-prone ("Side by Side by Sondheim", "Stand by Your Man",
// "Killed by Grace Kelly"), and the show id is NOT an oracle (ids are slugified
// from the title, so they always carry the byline). The oracle is an
// INDEPENDENT credit: the name must be a writer of this show (creativeTeam
// Playwright/Book/Writer/Author/Music/Lyrics role) or a known writer anywhere
// in the corpus (ctx.knownWriters, see buildKnownWriters). No oracle data, no strip.
const BYLINE_NAME = "[A-Z][\\p{L}'.\\-]*(?:\\s+(?:[A-Z][\\p{L}'.\\-]*|de|van|von|da|di|la|le)){1,3}";
const PLAYWRIGHT_BYLINE_RE = new RegExp('^(.*\\S)\\s+by\\s+(' + BYLINE_NAME + ')\\s*$', 'u');
const WRITER_ROLE_RE = /playwright|writer|author|book|music|lyric|libretto|adapt/i;

const CREDIT_WORD_RE = /^(?:(?:words|book|music|lyrics|songs|written|play|plays|story|a play|a musical)(?:\s+(?:and|&)\s+\w+)?)$/i;

function nameKey(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Set of nameKey()s of everyone credited in a writing role anywhere in shows. */
function buildKnownWriters(shows) {
  const out = new Set();
  for (const sh of shows || []) {
    for (const c of Array.isArray(sh.creativeTeam) ? sh.creativeTeam : []) {
      if (c && c.name && WRITER_ROLE_RE.test(c.role || '')) out.add(nameKey(c.name));
    }
  }
  return out;
}

/**
 * @param {string} title
 * @param {object} [show]
 * @param {Set<string>} [knownWriters]
 * @param {string} [sourceText] the source's own description of the show. A THIRD,
 *   weaker oracle for a first-time playwright nobody in the corpus credits yet
 *   (BRO-8054: TIC's "Calamity West" row). The name must appear in the source's
 *   own words AND at least two words must remain, so "Killed by Grace Kelly"
 *   (one word left) is never stripped on this oracle alone.
 * @returns {{title:string, name:string, oracle:string}|null}
 */
/**
 * BRO-8054: does the source description name `key` as the WRITER? A name merely
 * present is not enough: directors, actors and the subject of a biographical
 * show ("Songs Inspired by Nina Simone") are named there too. Accept when the
 * description credits the name as writer ("written by", "play by", ...), or when
 * the title that remains already has a subtitle ("Engines and Instruments of
 * Flight: A Fantasia in Three Acts"), which a title ending in "Inspired by X"
 * does not. A director credit always rejects.
 */
function descriptionCreditsWriter(sourceText, rest, key) {
  const text = ' ' + nameKey(sourceText) + ' ';
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!text.includes(' ' + key + ' ')) return false;
  if (new RegExp('\\b(?:directed by|director|direction by)\\s+(?:\\w+\\s+){0,2}' + k + '\\b|\\b' + k + '\\s+(?:directs|directed(?!\\s+by))\\b').test(text)) return false;
  const writerCue = new RegExp('\\b(?:written by|play by|comedy by|drama by|musical by|penned by|playwright|new work by)\\s+(?:\\w+\\s+){0,2}' + k + '\\b').test(text);
  const subtitled = /[:\u2013\u2014]\s*\S/.test(rest);
  return writerCue || subtitled;
}

function classifyPlaywrightByline(title, show, knownWriters, sourceText) {
  if (!title) return null;
  const m = PLAYWRIGHT_BYLINE_RE.exec(title);
  if (!m) return null;
  const rest = m[1].trim();
  const key = nameKey(m[2]);
  if (key.split(' ').length < 2) return null;
  // Revue/credit titles ("Music by Richard Rodgers", "Sondheim on Sondheim by
  // Stephen Sondheim"): the remainder is a bare credit word or already names the writer.
  if (CREDIT_WORD_RE.test(rest) || key.split(' ').some(t => t.length > 3 && nameKey(rest).split(' ').includes(t))) return null;
  const own = (show && Array.isArray(show.creativeTeam) ? show.creativeTeam : [])
    .some(c => c && c.name && WRITER_ROLE_RE.test(c.role || '') && nameKey(c.name) === key);
  if (own) return { title: rest, name: m[2], oracle: 'show-credits-writer' };
  if (knownWriters && knownWriters.has(key)) return { title: rest, name: m[2], oracle: 'corpus-known-writer' };
  if (sourceText && rest.split(/\s+/).length >= 2 && descriptionCreditsWriter(sourceText, rest, key)) {
    return { title: rest, name: m[2], oracle: 'source-description' };
  }
  return null;
}

const {
  isShoutedTitle,
  isExemptFromTitleCase,
  fixMisCasedRomanNumerals,
} = require('./title-display-case');

/**
 * @param {{id?:string, title:string, venue?:string}} show
 * @param {{venueVocabulary?: string[], knownWriters?: Set<string>, sourceText?: string}} [ctx]
 * @returns {{
 *   title: string,            // what the title SHOULD be (venue-suffix repairs only)
 *   changed: boolean,
 *   manualReview: boolean,    // shouted casing detected — a human owes us a source lookup
 *   steps: Array<{kind:'venue-suffix'|'genre-disambiguator'|'listing-year-suffix'|'playwright-byline'|'roman-numeral-case', from:string, to:string, oracle?:string}>
 * }}
 */
function normalizeShowTitle(show, ctx = {}) {
  const steps = [];
  let title = show && typeof show.title === 'string' ? show.title : '';
  const original = title;
  if (!title) return { title, changed: false, manualReview: false, steps };

  // 1. venue / producing-company suffix — to a FIXED POINT, not once.
  // "A Play (Luna Stage) (Soho Playhouse)" needs two passes, and a single
  // pass left the sweep reporting success while validate-data.js still
  // failed on the same row (adversarial review finding, reproduced). Bounded
  // so a pathological title cannot spin.
  for (let pass = 0; pass < MAX_VENUE_STRIP_PASSES; pass++) {
    const venueResult = classifyVenueSuffix(title, {
      id: show.id,
      venue: show.venue,
      venueVocabulary: ctx.venueVocabulary,
    });
    if (venueResult.action !== 'strip') break;
    steps.push({ kind: 'venue-suffix', from: title, to: venueResult.title, oracle: venueResult.oracle });
    title = venueResult.title;
  }

  // 1a. BRO-6268: a bare genre disambiguator a source appended to tell two
  // same-titled works apart. Theatricalia names the 2011 Gielgud musical
  // "Lend Me a Tenor (musical)" to separate it from the play. The venue
  // oracle only stripped it by accident (a regional "San Diego Musical
  // Theatre" venue made "Musical" a corpus venue token), so the result
  // depended on unrelated rows. Strip it deterministically. The show's
  // `type` field carries the genre; promote-historical-we.js reads the
  // genre hint from the raw candidate title before normalising.
  const genre = GENRE_DISAMBIGUATOR_RE.exec(title);
  if (genre) {
    const to = title.slice(0, genre.index).trim();
    if (to) {
      steps.push({ kind: 'genre-disambiguator', from: title, to });
      title = to;
    }
  }

  // 1a'. BRO-7156: "Berlin_2027" -> "Berlin" (see LISTING_YEAR_SUFFIX_RE).
  const yearTail = LISTING_YEAR_SUFFIX_RE.exec(title);
  if (yearTail) {
    const to = title.slice(0, yearTail.index).trim();
    if (to) {
      steps.push({ kind: 'listing-year-suffix', from: title, to });
      title = to;
    }
  }

  // 1a''. BRO-8051: trailing playwright byline (oracle-gated, see above).
  const byline = classifyPlaywrightByline(title, show, ctx.knownWriters, ctx.sourceText);
  if (byline) {
    steps.push({ kind: 'playwright-byline', from: title, to: byline.title, oracle: byline.oracle });
    title = byline.title;
  }

  // 1b. BRO-4567: title-cased Roman numerals ("Richard Ii" -> "Richard II").
  // Deterministic (the numeral's only correct form is upper case), so this
  // repairs rather than flags; validate-data.js errors with the expected
  // title and fix-show-titles.js --apply writes it.
  const roman = fixMisCasedRomanNumerals(title);
  if (roman.tokens.length) {
    steps.push({ kind: 'roman-numeral-case', from: title, to: roman.title });
    title = roman.title;
  }

  // 2. shouted casing, on the now-stripped title — DETECT, never guess-fix.
  const manualReview = isShoutedTitle(title) && !isExemptFromTitleCase(show.id, title);

  return { title, changed: title !== original, manualReview, steps };
}

/**
 * Write a normalizeShowTitle() result onto the row, with the provenance a later
 * scrape needs to spot a flip-flop, and the old title kept as a search alias
 * (search matches `title` and `akaTitles` only). The one writer for the sweep
 * (fix-show-titles.js), the ingestion builders and the write guard, so they
 * cannot disagree about what "healed" looks like.
 * @returns {{id:string, from:string, to:string, steps:string[], prev:object}}
 */
function applyNormalizedTitle(show, result, nowIso = new Date().toISOString()) {
  const prev = {
    title: show.title,
    titleNormalizedFrom: show.titleNormalizedFrom,
    titleNormalizedAt: show.titleNormalizedAt,
    akaTitles: Array.isArray(show.akaTitles) ? show.akaTitles.slice() : show.akaTitles,
  };
  const oldTitle = show.title;
  show.titleNormalizedFrom = oldTitle;
  show.titleNormalizedAt = nowIso;
  show.title = result.title;
  const aka = Array.isArray(show.akaTitles) ? show.akaTitles : [];
  if (oldTitle && !aka.some(t => String(t).trim().toLowerCase() === oldTitle.trim().toLowerCase())) {
    show.akaTitles = [...aka, oldTitle];
  }
  return { id: show.id, from: oldTitle, to: result.title, steps: result.steps.map(st => st.kind + (st.oracle ? ':' + st.oracle : '')), prev };
}

/** Put back exactly what applyNormalizedTitle() overwrote. */
function undoNormalizedTitle(show, healed) {
  for (const [k, v] of Object.entries(healed.prev)) {
    if (v === undefined) delete show[k]; else show[k] = v;
  }
}

/**
 * Heal the titles of the rows `only` selects (all rows when omitted), using the
 * SAME normalizeShowTitle() validate-data.js asks, with the whole corpus as
 * oracle. Shouted titles are never rewritten (BRO-3920): the row is left for a
 * human. Oracles are built from the PRE-HEAL corpus so healing row A cannot
 * change what row B is matched against.
 * @param {object[]} shows
 * @param {{only?: (show:object)=>boolean, nowIso?: string}} [opts]
 * @returns {Array} one applyNormalizedTitle() record per row healed
 */
function healShowTitles(shows, opts = {}) {
  const venueVocabulary = buildVenueVocabulary(shows);
  const knownWriters = buildKnownWriters(shows);
  const healed = [];
  for (const show of shows) {
    if (opts.only && !opts.only(show)) continue;
    const result = normalizeShowTitle(show, { venueVocabulary, knownWriters });
    if (!result.changed || result.manualReview) continue;
    healed.push(applyNormalizedTitle(show, result, opts.nowIso));
  }
  return healed;
}

module.exports = {
  normalizeShowTitle,
  applyNormalizedTitle,
  undoNormalizedTitle,
  healShowTitles,
  MAX_VENUE_STRIP_PASSES,
  GENRE_DISAMBIGUATOR_RE,
  LISTING_YEAR_SUFFIX_RE,
  classifyPlaywrightByline,
  buildKnownWriters,
  buildVenueVocabulary,
  isExemptFromTitleCase,
};
