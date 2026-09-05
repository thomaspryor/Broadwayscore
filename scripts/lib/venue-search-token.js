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
 * WHAT IT PICKS, in order:
 *   1. the first token that is neither a stopword nor a generic venue noun
 *      ("New Amsterdam Theatre" -> "Amsterdam", "St. James Theatre" -> "James")
 *   2. failing that, the first non-stopword token, even if generic
 *      ("The Theater Center" -> "Theater" — weak, but strictly better than "The")
 *   3. failing that, the original first token, so this can never return empty
 *      and can never make a query WORSE than the one it replaces
 *
 * Rule 3 is the important one: this function is a strict improvement or a
 * no-op, never a regression, which is what makes it safe to drop into a path
 * that already ships.
 *
 * Pure and separate from validate-show-venue.js per CLAUDE.md rule 15 — the
 * interesting behaviour is the token CHOICE, and that is only testable without
 * a network stub if it is pure.
 */

'use strict';

// Leading articles, prepositions and abbreviations that carry no search signal.
// 'new' earns its place on frequency alone: "New Amsterdam Theatre", "New World
// Stages" and "New York Theatre Workshop" all collapse onto it.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'at', 'of', 'on', 'in', 'and', 'new',
  'st', 'st.', 'ste', 'ste.', 'mt', 'mt.',
]);

// Words that are real tokens but describe what a venue IS rather than which
// venue it is. Skipped only when something more distinctive exists.
const GENERIC = new Set([
  'theatre', 'theater', 'theatres', 'theaters',
  'stage', 'stages', 'center', 'centre', 'hall', 'house', 'playhouse',
  'studio', 'space', 'room', 'club', 'arts', 'complex', 'auditorium',
]);

function normalize(token) {
  return String(token).toLowerCase().replace(/[^a-z0-9.]/g, '');
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

  // A 1-2 character fragment ("5", "at") is never a useful search term.
  const usable = tokens.filter((t) => normalize(t).length >= 3 && !isStopword(t));

  const distinctive = usable.find((t) => !GENERIC.has(normalize(t)));
  return distinctive || usable[0] || tokens[0];
}

module.exports = { venueSearchToken, STOPWORDS, GENERIC };
