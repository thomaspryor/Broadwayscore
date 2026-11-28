'use strict';

/**
 * production-match-gate.js — a STRONGER show-match for the broad (open-ended)
 * web-search discovery path, where generic titles ("The Truth", "Much Ado",
 * "The Misanthrope") otherwise pull in reviews of OTHER productions of the same
 * play (prior years, other venues, film/US stagings).
 *
 * serp-show-match.js (serpResultMentionsShow) only checks that the title string
 * appears — it has no production disambiguation. For the broad path we ALSO
 * require at least one signal that ties the result to THIS specific production:
 *   - a distinctive token from the venue name (e.g. "aldwych", "apollo"),
 *   - the opening year (e.g. "2026"),
 *   - a cast or creative-team surname,
 *   - a distinctive token from the showId slug (often the playwright or a
 *     qualifier, e.g. "florian"/"zeller" in
 *     the-truth-a-comedy-by-florian-zeller-west-end-2026).
 *
 * Philosophy (plan-review, User-Impact + Pre-mortem): for the broad net, a
 * MISSED review is safer than a WRONG-production review on a public page, so
 * this gate is deliberately strict — it rejects when it can't positively tie a
 * result to this production. The registered-outlet gather pass (Phase 1) still
 * catches the mainstream reviews without this gate.
 */

// Venue/role words that don't distinguish a production.
const VENUE_STOPWORDS = new Set([
  'the', 'theatre', 'theater', 'playhouse', 'royal', 'new', 'old', 'studio',
  'stage', 'hall', 'house', 'arts', 'centre', 'center', 'london', 'west', 'end',
  'at', 'and', 'on',
]);

// Slug words that are structural, not distinguishing.
const SLUG_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'by', 'and', 'or', 'at', 'in', 'on', 'to',
  'west', 'end', 'off', 'broadway', 'musical', 'play', 'comedy', 'drama',
  'new', 'revival', 'production', 'review', 'tour', 'uk', 'us',
]);

const { foldDiacritics } = require('./title-match');

function titleSlugTokens(showTitle) {
  return new Set(
    foldDiacritics(String(showTitle || ''))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean),
  );
}

function surname(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
}

/**
 * Build the set of lowercase signal tokens that distinguish this production.
 * @param {object} show  shows.json entry (venue, cast, creativeTeam, openingDate, id, title)
 * @returns {{ tokens: Set<string>, year: string|null }}
 */
function productionMatchSignals(show = {}) {
  const tokens = new Set();

  // Venue tokens (skip generic words).
  const venue = typeof show.venue === 'string' ? show.venue : (show.venue && show.venue.name) || '';
  for (const w of foldDiacritics(String(venue)).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)) {
    if (w.length >= 4 && !VENUE_STOPWORDS.has(w)) tokens.add(w);
  }

  // Opening year is deliberately NOT a positive signal: nearly every current
  // review mentions the current year, so a WRONG show that merely shares a title
  // word + the year would pass (the e2e run wrote a "Pride & Prejudice (*sort
  // of*)" review onto "Pride" via the year alone). Year is only useful as a
  // NEGATIVE filter (wrong-year → reject), which isUrlYearOutsideWindow already
  // does at the call site. Returned for callers but not added to `tokens`.
  const year = (show.openingDate && /^\d{4}/.test(show.openingDate)) ? show.openingDate.slice(0, 4) : null;

  // Cast + creative surnames (cap to keep the signal list tight).
  const people = []
    .concat(Array.isArray(show.cast) ? show.cast : [])
    .concat(Array.isArray(show.creativeTeam) ? show.creativeTeam : []);
  for (const p of people.slice(0, 12)) {
    const sn = surname(p && (p.name || p));
    if (sn.length >= 4) tokens.add(sn);
  }

  // Distinctive showId slug tokens (drops title words, structural words, the year).
  const titleTokens = titleSlugTokens(show.title);
  for (const w of String(show.id || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (w.length < 4) continue;
    if (/^\d{4}$/.test(w)) continue; // year handled above
    if (SLUG_STOPWORDS.has(w)) continue;
    if (titleTokens.has(w)) continue;
    tokens.add(w);
  }

  return { tokens, year };
}

function hasToken(haystack, token) {
  if (!token) return false;
  // Year + multi-char tokens: boundary match so "2026" doesn't hit "20261",
  // and "apollo" doesn't hit a longer accidental substring.
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * Does this broad-search result positively tie to THIS production?
 * @param {{title?:string, url?:string, description?:string, snippet?:string}} result
 * @param {object} show
 * @returns {boolean}
 */
function passesProductionMatch(result = {}, show = {}) {
  const { tokens } = productionMatchSignals(show);
  if (tokens.size === 0) return false; // no way to disambiguate → reject (safe)
  const haystack = [
    result.title,
    result.description || result.snippet,
    result.url || result.link,
  ].filter(Boolean).join(' ').toLowerCase();
  for (const t of tokens) {
    if (hasToken(haystack, t)) return true;
  }
  return false;
}

module.exports = { productionMatchSignals, passesProductionMatch, VENUE_STOPWORDS };
