/**
 * Shared Title Normalization Module
 *
 * Used across scripts that search external sites by show title.
 * Handles the many ways our show titles diverge from external naming:
 *   - Apostrophes / curly quotes breaking quoted searches
 *   - & vs "and"
 *   - Venue suffixes ("- Globe", "(Theatre Royal Stratford East)")
 *   - Format suffixes ("the Musical", "the Play", ": Both Parts")
 *   - Possessive prefixes ("Disney's", "Roald Dahl's")
 *   - "(The)" suffix vs "The" prefix
 *
 * Extracted from extract-theatre-record.js (2026-04-05).
 */

// ─── Venue names used in title suffixes ───
const VENUE_NAMES = [
  'globe', 'donmar', 'almeida', 'young vic', 'old vic', 'national',
  'barbican', 'soho', 'bush', 'royal court', 'hampstead', 'menier', 'arcola',
];

/**
 * Normalize a title for comparison.
 * Lowercases, strips accents, converts & → and, strips "The" prefix/suffix,
 * strips trailing parenthetical venue qualifiers, strips punctuation.
 */
function normalizeTitle(t) {
  return t.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')                   // & → and before stripping punctuation
    .replace(/^the\s+/, '')
    .replace(/\s*\(the\)\s*$/, '')           // TR uses "Lion King (The)" format
    .replace(/\s*\([^)]{5,}\)\s*$/, '')      // Strip trailing parenthetical venue qualifiers
    // Strip venue suffixes BEFORE punctuation removal (so "- Globe" matches)
    .replace(new RegExp(`\\s*[-–—]\\s*(?:${VENUE_NAMES.join('|')})$`, 'i'), '')
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Known WE venue names for "at the [venue]" stripping
const AT_THE_VENUES = [
  'kit\\s+kat\\s+club', 'apollo', 'savoy', 'vaudeville', 'adelphi', 'gielgud',
  'garrick', 'lyceum', 'palace', 'apollo\\s+victoria', 'noel\\s+coward', 'wyndhams',
  'criterion', 'phoenix', 'playhouse', 'duke\\s+of\\s+yorks', 'fortune', 'ambassadors',
  'st\\s+martins', 'novello', 'cambridge', 'gillian\\s+lynne', 'sondheim',
  'harold\\s+pinter', 'dominion', 'london\\s+coliseum', 'drury\\s+lane',
  'prince\\s+edward', 'prince\\s+of\\s+wales', 'piccadilly', 'shaftesbury',
  'theatre\\s+royal', 'hippodrome', 'trafalgar',
];
const AT_THE_PATTERN = new RegExp(`\\s+at\\s+the\\s+(${AT_THE_VENUES.join('|')}).*$`, 'i');

/**
 * Strip format/venue suffixes from a normalized title.
 * Used internally by titlesMatch and exported via cleanSearchTitle.
 */
function stripSuffix(s) {
  return s
    .replace(/\s*[-–—:]\s*(the\s+)?(musical|play|show|revue|opera|concert|experience)$/i, '')
    // Only strip "the Musical/Play/etc." when preceded by whitespace — not bare "play" at end
    // e.g. "SIX the Musical" → "SIX" but "Sad Gay AIDS Play" stays unchanged
    .replace(/\s+the\s+(musical|play|show|revue|opera|concert|experience)$/i, '')
    .replace(/\s*[-–—:]?\s*(both\s+)?parts?\s*(one\s+and\s+two|i\s+and\s+ii|\d+|[ivx]+)?$/i, '')
    // Only strip "at the [venue]" with known venue names
    .replace(AT_THE_PATTERN, '')
    .replace(/\s+live$/i, '')
    .replace(new RegExp(`\\s*[-–—]\\s*(?:${VENUE_NAMES.join('|')})$`, 'i'), '')
    .trim();
}

/**
 * Strip common possessive prefixes from a normalized title.
 */
function stripPrefix(s) {
  return s
    .replace(/^(?:disneys|roald dahls|shakespeares|agatha christies)\s+/i, '')
    .trim();
}

/**
 * Detect if a normalized title ends with a part/sequel indicator (e.g. "part 2", "part ii").
 * Returns the part indicator string or null.
 */
function hasPartSuffix(normalized) {
  const m = normalized.match(/\bparts?\s*(\d+|[ivx]+|one|two|three|four|five)$/i);
  return m ? m[0] : null;
}

/**
 * Check if two titles match — exact first, then strip suffixes/prefixes,
 * then allow prefix/suffix substring match at ≥70% length.
 */
function titlesMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;

  // Strip suffixes/prefixes, but guard against sequel mismatches:
  // "A Doll's House" vs "A Doll's House Part 2" must NOT match even after stripping
  const sa = stripSuffix(na), sb = stripSuffix(nb);
  if (sa === sb) {
    // Only match if both had the same type of part suffix (or neither had one)
    const partA = hasPartSuffix(na), partB = hasPartSuffix(nb);
    if (partA === partB || (!partA && !partB)) return true;
    // One has "Part X" and the other doesn't — different works
    return false;
  }

  const spa = stripPrefix(sa), spb = stripPrefix(sb);
  if (spa === spb) {
    const partA = hasPartSuffix(na), partB = hasPartSuffix(nb);
    if (partA === partB || (!partA && !partB)) return true;
    return false;
  }

  // Allow contains match if the shorter is ≥70% of the longer and ≥4 chars
  const [shorter, longer] = spa.length <= spb.length ? [spa, spb] : [spb, spa];
  if (shorter.length >= 4 && shorter.length >= longer.length * 0.7) {
    if (longer.startsWith(shorter) || longer.endsWith(shorter)) {
      // Reject if the remainder is a sequel/part indicator
      const remainder = longer.startsWith(shorter)
        ? longer.slice(shorter.length).trim()
        : longer.slice(0, longer.length - shorter.length).trim();
      if (/^parts?\s*(\d+|[ivx]+|one|two|three|four|five)$/i.test(remainder)) return false;
      return true;
    }
  }
  return false;
}

/**
 * Clean a show title for use in search queries.
 * Strips suffixes, prefixes, parentheticals, normalizes quotes and ampersands.
 * Does NOT lowercase (search engines are case-insensitive anyway).
 */
function cleanSearchTitle(title) {
  return title
    .replace(/[\u2018\u2019\u0060\u00B4]/g, "'")  // Normalize curly/backtick/acute apostrophes
    .replace(/[\u201C\u201D]/g, '"')             // Normalize curly quotes
    .replace(/&/g, 'and')                    // & → and
    .replace(/\s*\([^)]{5,}\)\s*$/, '')      // Strip trailing parenthetical (venue qualifiers)
    .replace(/\s*[-–—:]\s*(the\s+)?(musical|play|show|revue)$/i, '')
    .replace(/\s+the\s+(musical|play|show|revue)$/i, '')
    .replace(/\s*[-–—:]?\s*(both\s+)?parts?\s*(one\s+and\s+two|i\s+and\s+ii|\d+|[ivx]+)?$/i, '')
    .replace(AT_THE_PATTERN, '')
    .replace(/\s+live$/i, '')
    .replace(new RegExp(`\\s*[-–—]\\s*(?:${VENUE_NAMES.join('|')})$`, 'i'), '')
    .replace(/^(?:Disney's|Roald Dahl's|Shakespeare's|Agatha Christie's)\s+/i, '')
    .trim();
}

/**
 * For subtitled shows like "Beaches, A New Musical", return the short title
 * (everything before the first comma). Returns null if no comma or if the
 * short title is empty / identical to the full title.
 *
 * Used by URL/slug/title-match validators to accept outlet/aggregator pages
 * that use the short title only (2026-04-22 Beaches opening night: BWW RR,
 * NYT, Guardian, TB, etc. all indexed as "Beaches" — full-title validators
 * rejected all 22 reviews).
 */
function shortTitleCandidate(title) {
  if (!title) return null;
  const idx = title.indexOf(',');
  if (idx <= 0) return null;
  const short = title.slice(0, idx).trim();
  return (short && short !== title) ? short : null;
}

module.exports = { normalizeTitle, titlesMatch, cleanSearchTitle, stripSuffix, stripPrefix, shortTitleCandidate };
