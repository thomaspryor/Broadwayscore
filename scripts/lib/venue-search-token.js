/**
 * venue-search-token.js — pick the ONE venue word worth putting in a Playbill
 * lookup query (BRO-2821).
 *
 * WHY THIS EXISTS. validate-show-venue.js built its Playbill SERP queries as
 *
 *     const venueWord = (show.venue || '').split(/[\s\-,—\/]/)[0];
 *     `site:playbill.com/production "${show.title}" ${market} ${venueWord}`
 *
 * i.e. the FIRST whitespace token of the venue. For "New World Stages – Stage 5"
 * that token is the stopword "New", so the query degrades to
 *
 *     site:playbill.com/production "AMAZE" Off-Broadway New
 *
 * which carries no venue signal at all and cannot distinguish the right
 * production from any other. Falling through to a more expensive scraping
 * provider just re-asks the same useless question at higher cost.
 *
 * THIS IS NOT A ONE-SHOW BUG. Measured against the live corpus on 2026-09-05:
 * 202 of 2,943 shows carrying a venue (6.9%) have a first token that is a
 * stopword — "The" x92, "St." x60, "New" x49, "the" x1. Every one of those
 * shows was getting a degraded validation query. AMAZE was simply the one
 * somebody looked at.
 *
 * WHAT IT PICKS:
 *   1. the first token that is neither a stopword nor a generic venue noun
 *      ("New Amsterdam Theatre" -> "Amsterdam", "St. James Theatre" -> "James",
 *       "WP Theater" -> "WP", "Studio 54" -> "54")
 *   2. otherwise the EMPTY STRING, meaning "omit the venue term entirely"
 *
 * There is deliberately no generic-word fallback. A generic word is worse than
 * no word: "Theater" appears on every playbill.com/production page, so it looks
 * like it is scoping the query while matching everything. Returning '' leaves a
 * clean title+market query instead. Only 2 of the corpus's 355 distinct venues
 * hit that branch ("The Theater Center", "Playhouse Theatre").
 *
 * RELATIONSHIP TO scripts/lib/serp-review-census.js:75 venueQueryToken(). That
 * function solves the same shape for the review census and reaches the same
 * "return null rather than a generic word" conclusion independently. The two
 * deliberately differ: census lowercases and folds diacritics because its
 * queries are normalized, and its stopword list is broader (it also drops
 * royal/world/city/street/east/west) because a census query that over-matches
 * costs a wasted SERP call, whereas here an over-broad token costs a WRONG
 * Playbill URL written into the durable cache. Consolidating the two
 * vocabularies is tracked separately rather than done here, because changing
 * census's list would move the census's own results.
 *
 * Pure and separate from validate-show-venue.js per CLAUDE.md rule 15 — the
 * interesting behaviour is the token CHOICE, and that is only testable without
 * a network stub if it is pure.
 */

'use strict';

const { foldDiacritics } = require('./title-match');

// Leading articles, prepositions and abbreviations that carry no search signal.
// 'new' earns its place on frequency alone: "New Amsterdam Theatre", "New World
// Stages" and "New York Theatre Workshop" all collapse onto it.
// The function words matter as much as the articles. Adversarial review
// (Codex, 2026-09-05) found the one live-corpus venue where omitting them
// broke this function's own contract: "Theatre for a New Audience/Polonsky
// Shakespeare Center" skipped the generic "Theatre" and returned "for", which
// is strictly WORSE than the first token the old code used. Anything that can
// be the second word of a venue name without naming it belongs here.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'at', 'of', 'on', 'in', 'and', 'new',
  'for', 'with', 'from', 'by', 'to', 'its',
  'st', 'st.', 'ste', 'ste.', 'mt', 'mt.',
]);

// Words that are real tokens but describe what a venue IS rather than which
// venue it is. Skipped only when something more distinctive exists.
const GENERIC = new Set([
  'theatre', 'theater', 'theatres', 'theaters',
  'stage', 'stages', 'center', 'centre', 'hall', 'house', 'playhouse',
  'studio', 'space', 'room', 'club', 'arts', 'complex', 'auditorium',
]);

// Fold BEFORE the non-ASCII strip, never after. Stripping first deletes the
// accented letter outright ("Théâtre" -> "thtre"), which silently changes which
// token this function calls distinctive and sends a misspelled venue to the
// Playbill lookup. Folding first preserves the letter ("theatre"), so an
// accented venue name normalizes onto the same token as its unaccented spelling.
// Same ordering as article-extractor.js:393. Guarded by the structural test in
// tests/unit/sibling-matchers-diacritics.test.mjs (task #648).
function normalize(token) {
  return foldDiacritics(String(token).toLowerCase()).replace(/[^a-z0-9.]/g, '');
}

function isStopword(token) {
  const n = normalize(token);
  return STOPWORDS.has(n) || STOPWORDS.has(n.replace(/\.$/, ''));
}

/**
 * @param {string} venue  a venue name, e.g. "New World Stages – Stage 5"
 * @returns {string} the single most distinctive token, or '' for no venue
 */
function venueSearchToken(venue) {
  const tokens = String(venue == null ? '' : venue)
    .split(/[\s\-,—/]+/)
    .filter(Boolean);
  if (!tokens.length) return '';

  // A GENERIC word is never an acceptable answer, not even as a last resort.
  // Two independent adversarial reviews (Codex and a codebase-aware reviewer,
  // both 2026-09-05) landed on the same defect from different directions: the
  // first version fell back to `usable[0]` when every candidate was generic,
  // which turned "WP Theater" (5 shows) into "Theater" — a word that appears on
  // EVERY playbill.com/production page, so the venue term stopped scoping the
  // query at all. That is strictly worse than the "WP" the old code produced.
  //
  // So: return the first token that is neither a stopword nor generic, and
  // otherwise return NOTHING. An empty token means "omit the venue term", which
  // leaves a clean title+market query. A generic token is worse than no token,
  // because it looks like scoping while matching everything. Only 2 of the 355
  // distinct venues in the corpus ("The Theater Center", "Playhouse Theatre",
  // 5 shows between them) have no distinctive word at all.
  //
  // The length floor is 2, not 3: "WP Theater" and "59E59 Theaters" carry their
  // identity in a two-character token, and "Studio 54" / "Stage 42" carry it in
  // the number that a 3-character floor discarded.
  const distinctive = tokens.find((t) => {
    const n = normalize(t);
    return n.length >= 2 && !isStopword(t) && !GENERIC.has(n);
  });
  return distinctive || '';
}

module.exports = { venueSearchToken, STOPWORDS, GENERIC };
