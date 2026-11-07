'use strict';

/**
 * Pure venue / title token helpers (BRO-4884). Split out of
 * creative-team-verify.js so callers on the read-only (safe-form) path, such
 * as lib/tour-stop-carveout.js and excerpt-validation.js, do not pull that
 * module's network code (url-discovery) into their require graph.
 * creative-team-verify.js re-exports these unchanged.
 */

const { foldDiacritics } = require('./title-match');

/**
 * Normalize typographic variance before substring matching: curly quotes →
 * straight, en/em dashes → hyphen, collapsed whitespace. Snippets and our
 * titles disagree on these constantly ("I'm Sorry, Prime Minister" with a
 * curly apostrophe never matches a straight-quoted snippet otherwise).
 * See memory/feedback_word_boundary_punct_titles.md for the general rule.
 */
function normalizeForMatch(s) {
  // foldDiacritics: SERP snippets spell names and titles with their real
  // accents ("Édouard Louis", "Thérèse Raquin") while shows.json is mixed, so
  // an unfolded compare drops the confirmation entirely. Task #648.
  return foldDiacritics(s || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-word containment for a title token. A plain substring check let the
 * one-letter title "G" (Royal Court 2024, by Tife Kusoro) anchor any snippet
 * containing a "g", which "confirmed" an invented Inua Ellams credit
 * (BRO-4884).
 */
function containsToken(text, token) {
  if (!token) return false;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`).test(text);
}

/**
 * One-word venue names that are ordinary words or shared with other venues
 * ("lyric" is in every "lyrics by" credit, "national" in "national tour",
 * "palace" in Palace Theatre Manchester). These anchor only as "<word>
 * theatre".
 */
const GENERIC_VENUE_WORDS = new Set([
  'lyric', 'national', 'playhouse', 'apollo', 'palace', 'arts', 'park', 'globe',
  'hope', 'rose', 'shed', 'yard', 'soho', 'cell', 'new', 'old', 'royal', 'little',
  'union', 'studio', 'courtyard', 'bridge', 'gate', 'orange', 'tabard', 'kiln',
  'main', 'space', 'chain', 'tank', 'bush', 'booth', 'axis', 'public',
]);

/**
 * Lowercase tokens that name a production's venue in published coverage:
 * "Wyndham's Theatre" -> "wyndhams", "Theatre Royal Haymarket" -> "haymarket",
 * "Lyric Theatre" -> "lyric theatre", and a National Theatre stage also
 * matches "national theatre". Compound names ("Laura Pels Theatre at the ...",
 * "Lincoln Center Theater - Mitzi E. Newhouse") give one token per part.
 * Apostrophes are dropped (snippets write both "Wyndham's" and "Wyndhams").
 */
function venueTokens(venue) {
  const v = normalizeForMatch(venue).replace(/'/g, '');
  if (!v || /^(tba|tbc|unknown)$/.test(v)) return [];
  const tokens = [];
  const parts = v.split(/\s+[-–]\s+|\s+at\s+(?:the\s+)?|\/|\(|\)|,/).map(x => x.trim()).filter(Boolean);
  for (const part of parts) {
    const full = part.replace(/^the\s+/, '');
    if (/^(theatre royal|theatre|theater)$/.test(full)) continue; // "Theatre Royal, Haymarket"
    const core = full
      .replace(/^theatre royal\s+/, '')
      .replace(/\s+(theatre|theater|playhouse)$/, '')
      .replace(/^@/, '')
      .trim();
    if (!core) continue;
    const oneWord = !/\s/.test(core);
    if (core.length < 4 || (oneWord && GENERIC_VENUE_WORDS.has(core))) {
      // "MCC Theater", "Lyric Theatre": only the full name is specific enough.
      if (full !== core && full.length >= 6) tokens.push(full);
    } else {
      tokens.push(core);
    }
  }
  if (/\b(lyttelton|olivier|dorfman)\b/.test(v) || /national theatre/.test(v)) tokens.push('national theatre');
  return [...new Set(tokens)];
}

module.exports = { normalizeForMatch, containsToken, venueTokens, GENERIC_VENUE_WORDS };
