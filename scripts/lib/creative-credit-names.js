'use strict';

// Page identities, shared by the profile builder and redirect emitter (BRO-5406).
// Raw source credits stay intact for show pages. The backfill splitter has a
// different policy and imports the scraper, so it cannot serve the page bundle.
const INTACT_CREDITS = new Set(['Bob & Bill', 'Max Martin and Friends']);
const CREDIT_NAMES = {
  // on-your-toes-1983 also credits both full names for Music and Lyrics.
  'Rodgers & Hart and George Abbott': ['Richard Rodgers', 'Lorenz Hart', 'George Abbott'],
  'Keone & Mari Madrid': ['Keone Madrid', 'Mari Madrid'],
};

/**
 * Named collaborators become separate page identities, in credit order.
 * Collectives remain named entities; parenthetical band members and vague
 * collaborators never become invented people. Preserve suffix punctuation so
 * a split name merges with the same exact individual credit.
 * @param {string} name
 * @returns {string[]}
 */
function creativeCreditNames(name) {
  if (Object.hasOwn(CREDIT_NAMES, name)) return [...CREDIT_NAMES[name]];
  if (INTACT_CREDITS.has(name) || /\([^)]*(?:&|\band\b)[^)]*\)/i.test(name)) return [name];
  if (!/\s(?:and|&|with)\s/i.test(name)) return [name];
  // A company name with a conjunction is one entity, not two people.
  if (/\b(?:Productions|Associates|Group|Studio|Collective|Theatre|Theater|Company|Design|Sound|Audio|Orchestra)\b/i.test(name)) return [name];

  const parts = name.split(/,(?!\s*(?:Jr\.?|Sr\.?|II|III|IV)\b)\s*(?:(?:and|&)\s+)?|\s+(?:and|&|with)\s+/i).map(n => n.trim());
  if (parts.length < 2 || parts.some(n => !n || /^(?:and|with|friends|others)$/i.test(n) || /^[a-z]/.test(n))) return [name];
  return parts;
}

module.exports = { creativeCreditNames };
