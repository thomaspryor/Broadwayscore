'use strict';

/**
 * tr-production-sections.js — split a theatre.reviews round-up that covers
 * two productions of one show (BRO-7545).
 *
 * When a show transfers, TR does not post a new round-up: it edits the
 * original post and adds a section per production, e.g. on
 * /reviews-roundup/1536-almeida-reviews/:
 *   <h4>Reviews for the West End transfer</h4>        (Ambassadors 2026 rows)
 *   <h4>Reviews of the premiere at The Almeida</h4>    (Almeida 2025 rows)
 * and on Into the Woods:
 *   <h4>Reviews from the transfer to the Noël Coward Theatre</h4>
 *   <h4>Reviews from the run at the Bridge Theatre</h4>
 * The post date only identifies the first production, so every row on the
 * page went to that id: the transfer's reviews landed on the premiere and the
 * transfer id got none (its archive copy was quarantined as another show's).
 *
 * Each section heading is resolved to ONE same-title London production, by
 * the venue it names first, then by "West End", then by declared priorRuns.
 * A page with fewer than two production headings is left as it was.
 */

const { normalizeTitle } = require('./title-match');
const { isLondonMarket } = require('./venue-classification');

// "Reviews for/from/of the ..." headings only; other <h4>s are not sections.
const PRODUCTION_HEADING = /^\s*reviews?\s+(?:for|from|of)\s+(?:the\s+)?(.+?)\s*$/i;
const TRANSFER_WORDS = /\b(?:transfer|transferred|return|returns|revival|reopen\w*)\b/i;
const ORIGINAL_WORDS = /\b(?:premiere|original|first|debut)\b/i;

// Words in a heading or venue that do not identify a house.
const NOISE = new Set([
  'the', 'a', 'an', 'of', 'at', 'to', 'in', 'on', 'for', 'from', 'and', 'by', 'its', 'run', 'runs',
  'theatre', 'theater', 'london', 'west', 'end', 'royal', 'playhouse', 'production', 'season',
  'transfer', 'transferred', 'return', 'returns', 'revival', 'premiere', 'original', 'first', 'debut',
  'reopening', 'reopened', 'new', 'cast', 'company', 'centre', 'center', 'house', 'hall',
]);

function tokens(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['‘’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !NOISE.has(w));
}

/** Heading text -> the production phrase after "Reviews for the", or null. */
function productionHeading(text) {
  const m = String(text || '').replace(/\s+/g, ' ').match(PRODUCTION_HEADING);
  return m ? m[1] : null;
}

/** Same-title London productions of `show` (including itself). */
function siblingsOf(show, shows) {
  const key = normalizeTitle(show.title);
  return (shows || []).filter((s) => s && s.id && s.title && normalizeTitle(s.title) === key
    && (s.id === show.id || isLondonMarket(s.category)));
}

/** Is `s` declared as a later run of `other` (priorRuns names its id or venue)? */
function declaresPriorRun(s, other) {
  const venueKey = tokens(other.venue).join(' ');
  return (Array.isArray(s.priorRuns) ? s.priorRuns : []).some((r) => r
    && ((r.id && r.id === other.id) || (venueKey && tokens(r.venue).join(' ') === venueKey)));
}

/**
 * Resolve one heading phrase to a sibling id, or null when it cannot be told.
 * @param {string} phrase productionHeading() output
 * @param {object[]} siblings same-title London productions
 */
function resolveSection(phrase, siblings) {
  const words = tokens(phrase);
  // 1. A house named in the heading ("transfer to the Noël Coward Theatre").
  if (words.length) {
    const byVenue = siblings.filter((s) => {
      const vt = new Set(tokens(s.venue));
      return vt.size > 0 && words.some((w) => vt.has(w));
    });
    if (byVenue.length === 1) return byVenue[0].id;
    if (byVenue.length > 1) return null;
  }
  // 2. "the West End transfer": the one West End production.
  if (/\bwest\s+end\b/i.test(phrase)) {
    const we = siblings.filter((s) => s.category === 'west-end');
    if (we.length === 1) return we[0].id;
  }
  // 3. priorRuns link the two productions: the later one is the transfer, the
  //    earlier one the premiere. Without that link a same-title revival from
  //    another era could take the section, so nothing is guessed.
  const later = siblings.filter((s) => siblings.some((o) => o.id !== s.id && declaresPriorRun(s, o)));
  if (TRANSFER_WORDS.test(phrase) && later.length === 1) return later[0].id;
  if (ORIGINAL_WORDS.test(phrase) && later.length === 1) {
    const earlier = siblings.filter((o) => o.id !== later[0].id && declaresPriorRun(later[0], o));
    if (earlier.length === 1) return earlier[0].id;
  }
  return null;
}

/**
 * @param {string[]} phrases production headings in page order
 * @param {object} show the show the page is being read for
 * @param {object[]} shows shows.json rows
 * @returns {Array<string|null>} owner id per heading, or null when there are
 *   fewer than two headings (single-production page: no split).
 */
function resolveSections(phrases, show, shows) {
  if (!Array.isArray(phrases) || phrases.length < 2 || !show) return null;
  const sibs = siblingsOf(show, shows);
  // Only one production of this title is tracked: every section is it.
  if (sibs.length < 2) return phrases.map(() => show.id);
  return phrases.map((p) => resolveSection(p, sibs));
}

/**
 * Keep the rows that belong to `show`.
 * @param {Array<{row:object, section:number}>} tagged section = heading index, -1 before any heading
 * @param {string|null} [matchedShowId] the show the round-up was matched to. On
 *   a split page, rows above the first heading go to that show only (never to
 *   every production, which wrote them twice), and to none when it is unknown.
 * @returns {{rows:object[], owners:Array<string|null>|null, dropped:number,
 *   unresolved:Array<{heading:string, rows:number}>, preamble:number}}
 */
function rowsForShow(tagged, phrases, show, shows, matchedShowId = null) {
  const owners = resolveSections(phrases, show, shows);
  if (!owners) return { rows: tagged.map((t) => t.row), owners: null, dropped: 0, unresolved: [], preamble: 0 };
  // Unresolved sections are dropped, not given to `show`: on a two-production
  // page the default would be the wrong production half the time.
  const preambleOwner = matchedShowId != null && matchedShowId === show.id;
  const keep = (t) => (t.section < 0 ? preambleOwner : owners[t.section] === show.id);
  const rows = tagged.filter(keep).map((t) => t.row);
  const unresolved = owners
    .map((id, i) => ({ id, heading: phrases[i], rows: tagged.filter((t) => t.section === i).length }))
    .filter((u) => u.id == null && u.rows > 0)
    .map(({ heading, rows: n }) => ({ heading, rows: n }));
  const preamble = preambleOwner ? 0 : tagged.filter((t) => t.section < 0).length;
  return { rows, owners, dropped: tagged.length - rows.length, unresolved, preamble };
}

/** Other productions that own a section of this page (to write them too). */
function otherSectionOwners(owners, showId) {
  return [...new Set((owners || []).filter((id) => id && id !== showId))];
}

module.exports = { productionHeading, resolveSection, resolveSections, rowsForShow, otherSectionOwners, siblingsOf };
