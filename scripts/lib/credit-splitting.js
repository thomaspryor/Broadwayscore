#!/usr/bin/env node
/**
 * Credit Splitting Utility
 *
 * Splits combined "X and Y" creative team entries into separate entries
 * for individual creator pages. Only splits creative roles (Director,
 * Playwright, Book, Music, Lyrics, Choreographer), NOT design credits.
 */

const { isValidCreativeTeamName } = require('./ibdb-dates');

// Roles eligible for splitting into individual entries
const SPLITTABLE_ROLES = new Set([
  'Director', 'Directors',
  'Playwright', 'Written By', 'Writer', 'Co-Writer',
  'Book', 'Book Writer',
  'Music', 'Lyrics', 'Music & Lyrics', 'Music & Lyrics (catalog)',
  'Book & Lyrics', 'Lyrics & Book',
  'Book, Music & Lyrics', 'Music, Lyrics & Book',
  'Choreographer', 'Choreography', 'Choreographers',
  'Composer', 'Lyricist', 'English Lyrics',
  'Adaptation',
]);

// Manual overrides for names that can't be auto-split correctly
// Maps combined name → array of individual names
const MANUAL_SPLITS = {
  'Keone & Mari Madrid': ['Keone Madrid', 'Mari Madrid'],
  'Katori Hall with Frank Ketelaar and Kees Prins': ['Katori Hall', 'Frank Ketelaar', 'Kees Prins'],
  'Oscar Hammerstein II and Joshua Logan': ['Oscar Hammerstein II', 'Joshua Logan'],
  'Scott Graham, Steven Hoggett and Frantic Assembly': ['Scott Graham', 'Steven Hoggett'],
};

// Known combined names that should NOT be split (bands, duos, companies)
const DO_NOT_SPLIT = new Set([
  'The Rescues',
  'Jamestown Revival and Justin Levine',
  'Stew and Heidi Rodewald',
  'Sara Bareilles and The Waitress Band',
  'The Grundleshotz and Ken Davenport',
  'Tye Blue, Marla Mindelle, and Constantine Rousouli',
  'Lauren Yalango-Grant and Christopher Cree Grant',
  'Doug Besterman and Mike Morris',
  'Justin Ellington and Connor Wang',
  'Rob Milburn and Michael Bodeen',
  'Ryuichi Sakamoto and Alva Noto',
  'King James Bible and William Tyndale',
  'Max Martin and Friends',
  'Bob & Bill',
]);

// Words that suggest a company/collective rather than multiple people
const COMPANY_INDICATORS = [
  'Design', 'Productions', 'Assembly', 'Associates', 'Group',
  'Studio', 'Collective', 'Theatre', 'Theater', 'Company',
  'Sound', 'Audio', 'Band', 'Orchestra',
];

/**
 * Check if a name contains multiple people that can be split.
 * @param {string} name
 * @returns {boolean}
 */
function hasCombinedNames(name) {
  if (DO_NOT_SPLIT.has(name)) return false;
  // Manual overrides always split
  if (MANUAL_SPLITS[name]) return true;
  // Skip names with parentheses (e.g., "ABBA (Benny Andersson & Björn Ulvaeus)")
  if (/\(.*[&].*\)/.test(name) || /\(.*\band\b.*\)/i.test(name)) return false;
  // Must contain " and ", " & ", or " with "
  return / and /i.test(name) || / & /i.test(name) || / with /i.test(name);
}

/**
 * Split a combined name string into individual names.
 * @param {string} name - e.g. "Trevor Nunn and John Caird"
 * @returns {string[]|null} - Individual names, or null if should not split
 */
function splitNames(name) {
  if (DO_NOT_SPLIT.has(name)) return null;
  // Manual overrides — return pre-defined splits
  if (MANUAL_SPLITS[name]) return MANUAL_SPLITS[name];
  // Skip names with parenthetical & or "and" (e.g., "ABBA (Benny Andersson & Björn Ulvaeus)")
  if (/\(.*[&].*\)/.test(name) || /\(.*\band\b.*\)/i.test(name)) return null;

  // Pre-process: protect "Jr." and "Sr." suffixes from comma splitting
  // "Richard Maltby, Jr." → "Richard Maltby Jr." before splitting
  let processedName = name
    .replace(/,\s*(Jr\.?|Sr\.?|III|IV|II)\b/gi, ' $1');

  let parts;

  // Pattern: "X, Y, and Z" or "X, Y and Z" (Oxford comma optional)
  if (/, /.test(processedName) && / and /i.test(processedName)) {
    // Split on comma first, then split last part on " and "
    const commaParts = processedName.split(/,\s*/);
    parts = [];
    for (const part of commaParts) {
      if (/ and /i.test(part)) {
        parts.push(...part.split(/ and /i).map(s => s.trim()));
      } else {
        parts.push(part.trim());
      }
    }
  } else if (/, /.test(processedName) && / & /.test(processedName)) {
    // Pattern: "X, Y & Z" (comma + ampersand)
    const commaParts = processedName.split(/,\s*/);
    parts = [];
    for (const part of commaParts) {
      if (/ & /.test(part)) {
        parts.push(...part.split(/ & /).map(s => s.trim()));
      } else {
        parts.push(part.trim());
      }
    }
  } else if (/ and /i.test(processedName)) {
    // Pattern: "X and Y"
    parts = processedName.split(/ and /i).map(s => s.trim());
  } else if (/ with /i.test(processedName)) {
    // Pattern: "X with Y" (rare, e.g. "Katori Hall with Frank Ketelaar and Kees Prins")
    parts = processedName.split(/ with /i).map(s => s.trim());
  } else if (/ & /.test(processedName)) {
    // Pattern: "X & Y" (but not "Music & Lyrics" style role names)
    parts = processedName.split(/ & /).map(s => s.trim());
  } else {
    return null;
  }

  // Filter empty parts
  parts = parts.filter(p => p.length > 0);

  if (parts.length < 2) return null;

  // Validate each part
  for (const part of parts) {
    // Single word is not a person name (except rare mononyms like "Kamauu")
    if (part.split(/\s+/).length === 1 && part.length < 4) return null;

    // Too many words (likely a company/collective)
    if (part.split(/\s+/).length > 4) return null;

    // Starts with lowercase (likely not a person name)
    if (/^[a-z]/.test(part) && part !== 'dots') return null;

    // Contains company indicators
    for (const indicator of COMPANY_INDICATORS) {
      if (part.includes(indicator)) return null;
    }

    // Fails name validation
    if (!isValidCreativeTeamName(part)) return null;
  }

  return parts;
}

/**
 * Split combined creative team entries into individual entries.
 * Only splits eligible roles (Director, Playwright, Book, Music, Lyrics, Choreographer).
 *
 * @param {Array<{name: string, role: string}>} creativeTeam
 * @returns {{ result: Array<{name: string, role: string}>, splitCount: number }}
 */
function splitCombinedCredits(creativeTeam) {
  if (!creativeTeam || creativeTeam.length === 0) {
    return { result: [], splitCount: 0 };
  }

  const result = [];
  let splitCount = 0;

  for (const entry of creativeTeam) {
    // Only split eligible roles
    if (!SPLITTABLE_ROLES.has(entry.role)) {
      result.push(entry);
      continue;
    }

    // Check if name can be split
    if (!hasCombinedNames(entry.name)) {
      result.push(entry);
      continue;
    }

    const names = splitNames(entry.name);
    if (!names) {
      result.push(entry);
      continue;
    }

    // Split into individual entries
    for (const name of names) {
      result.push({ name, role: entry.role });
    }
    splitCount++;
  }

  return { result, splitCount };
}

module.exports = { splitCombinedCredits, splitNames, hasCombinedNames, SPLITTABLE_ROLES, DO_NOT_SPLIT };
