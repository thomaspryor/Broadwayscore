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
  'Playwright', 'Written By', 'Writer',
  'Book', 'Book Writer',
  'Music', 'Lyrics', 'Music & Lyrics',
  'Choreographer', 'Choreography', 'Choreographers',
  'Composer', 'Lyricist',
  'Adaptation',
]);

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
  // Skip names with parentheses (e.g., "ABBA (Benny Andersson & Björn Ulvaeus)")
  if (/\(.*[&].*\)/.test(name) || /\(.*\band\b.*\)/i.test(name)) return false;
  // Must contain " and " or " & "
  return / and /i.test(name) || / & /i.test(name);
}

/**
 * Split a combined name string into individual names.
 * @param {string} name - e.g. "Trevor Nunn and John Caird"
 * @returns {string[]|null} - Individual names, or null if should not split
 */
function splitNames(name) {
  if (DO_NOT_SPLIT.has(name)) return null;
  // Skip names with parenthetical & or "and" (e.g., "ABBA (Benny Andersson & Björn Ulvaeus)")
  if (/\(.*[&].*\)/.test(name) || /\(.*\band\b.*\)/i.test(name)) return null;

  let parts;

  // Pattern: "X, Y, and Z" or "X, Y and Z" (Oxford comma optional)
  if (/, /.test(name) && / and /i.test(name)) {
    // Split on comma first, then split last part on " and "
    const commaParts = name.split(/,\s*/);
    parts = [];
    for (const part of commaParts) {
      if (/ and /i.test(part)) {
        parts.push(...part.split(/ and /i).map(s => s.trim()));
      } else {
        parts.push(part.trim());
      }
    }
  } else if (/, /.test(name) && / & /.test(name)) {
    // Pattern: "X, Y & Z" (comma + ampersand)
    const commaParts = name.split(/,\s*/);
    parts = [];
    for (const part of commaParts) {
      if (/ & /.test(part)) {
        parts.push(...part.split(/ & /).map(s => s.trim()));
      } else {
        parts.push(part.trim());
      }
    }
  } else if (/ and /i.test(name)) {
    // Pattern: "X and Y"
    parts = name.split(/ and /i).map(s => s.trim());
  } else if (/ & /.test(name)) {
    // Pattern: "X & Y" (but not "Music & Lyrics" style role names)
    parts = name.split(/ & /).map(s => s.trim());
  } else {
    return null;
  }

  // Filter empty parts
  parts = parts.filter(p => p.length > 0);

  if (parts.length < 2) return null;

  // Validate each part
  for (const part of parts) {
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
