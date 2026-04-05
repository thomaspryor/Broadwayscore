#!/usr/bin/env node
/**
 * Test suite for title-normalization.js module
 *
 * Tests all 7 known title-matching bug patterns plus edge cases.
 * Run: node scripts/test-title-normalization.js
 */

const { normalizeTitle, titlesMatch, cleanSearchTitle, stripSuffix, stripPrefix } = require('./lib/title-normalization');

let passed = 0;
let failed = 0;

function assert(condition, description) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${description}`);
  }
}

// ============================================================================
// normalizeTitle
// ============================================================================

console.log('--- normalizeTitle ---');

assert(normalizeTitle("Jaja's African Hair Braiding") === 'jajas african hair braiding',
  'Strips apostrophes');
assert(normalizeTitle('Marie & Rosetta') === 'marie and rosetta',
  '& → and');
assert(normalizeTitle('The Lion King') === 'lion king',
  'Strips leading The');
assert(normalizeTitle('Lion King (The)') === 'lion king',
  'Strips trailing (The)');
assert(normalizeTitle('Here There Are Blueberries (Theatre Royal Stratford East)') === 'here there are blueberries',
  'Strips trailing parenthetical venue qualifier');
assert(normalizeTitle('Deep Azure - Globe') === 'deep azure',
  'Strips venue suffix with dash');
assert(normalizeTitle('Café Society') === 'cafe society',
  'Strips accents via NFD');
// Leading whitespace preserves "the" since ^the\s+ doesn't match after spaces
// In practice, titles never have leading whitespace
assert(normalizeTitle('The   Lion   King') === 'lion king',
  'Collapses whitespace and strips The');

// ============================================================================
// titlesMatch — the 7 bug patterns
// ============================================================================

console.log('--- titlesMatch (7 bug patterns) ---');

// Bug 1: Apostrophes
assert(titlesMatch("Jaja's African Hair Braiding", "Jaja\u2019s African Hair Braiding"),
  'Curly apostrophe matches straight');
assert(titlesMatch("Jaja's African Hair Braiding", 'Jajas African Hair Braiding'),
  'With/without apostrophe matches after normalization');

// Bug 2: & vs and
assert(titlesMatch('Marie & Rosetta', 'Marie and Rosetta'),
  '& matches and');

// Bug 3: Venue suffixes
assert(titlesMatch('Deep Azure - Globe', 'Deep Azure'),
  'Dash-venue suffix stripped');
assert(titlesMatch('Here There Are Blueberries (Theatre Royal Stratford East)', 'Here There Are Blueberries'),
  'Parenthetical venue stripped');
assert(titlesMatch('Hamlet - Donmar', 'Hamlet'),
  'Donmar venue suffix stripped');

// Bug 4: "the Musical" / "the Play" suffixes
assert(titlesMatch('SIX the Musical', 'SIX'),
  '"the Musical" suffix stripped');
assert(titlesMatch('Kinky Boots The Musical', 'Kinky Boots'),
  '"The Musical" (capital) suffix stripped');
assert(titlesMatch('Cats: The Musical', 'Cats'),
  '": The Musical" suffix stripped');

// Bug 5: ": Both Parts" and similar
assert(titlesMatch('Harry Potter And The Cursed Child: Both Parts', 'Harry Potter and the Cursed Child'),
  '": Both Parts" suffix stripped');

// Bug 6: Prefix mismatches
assert(titlesMatch("Disney's Hercules", 'Hercules'),
  "Disney's prefix stripped");
assert(titlesMatch("Roald Dahl's Matilda", 'Matilda'),
  "Roald Dahl's prefix stripped");
assert(titlesMatch("Shakespeare's Macbeth", 'Macbeth'),
  "Shakespeare's prefix stripped");
assert(titlesMatch("Agatha Christie's Witness for the Prosecution", 'Witness for the Prosecution'),
  "Agatha Christie's prefix stripped");

// Bug 7: (The) suffix vs The prefix
assert(titlesMatch('The Lion King', 'Lion King (The)'),
  'The prefix matches (The) suffix');

// ============================================================================
// titlesMatch — safety: must NOT match
// ============================================================================

console.log('--- titlesMatch (negative cases) ---');

assert(!titlesMatch('Wicked', 'Wicked Lady'),
  'Wicked does NOT match Wicked Lady (70% threshold)');
assert(!titlesMatch('Bug', 'Debugging'),
  'Bug does NOT match Debugging (too short for prefix match)');
assert(!titlesMatch('Cats', 'Cats and Dogs: A Musical'),
  'Cats does NOT match long unrelated title');
assert(!titlesMatch('Hamilton', 'Lady Hamilton: A Life'),
  'Hamilton does NOT match Lady Hamilton');
assert(!titlesMatch('The Boy At The Back Of The Class', 'The Boy'),
  'Does NOT strip "At The Back Of The Class" (not a venue)');
// Note: "Sad Gay AIDS Play" vs "Sad Gay AIDS" matches via 70% prefix containment
// (26/31 = 84%). This is correct — they ARE the same show. cleanSearchTitle is
// where over-stripping matters (for search queries).

// ============================================================================
// titlesMatch — other venue/format combos
// ============================================================================

console.log('--- titlesMatch (extra combos) ---');

assert(titlesMatch('Cabaret at the Kit Kat Club', 'Cabaret'),
  '"at the Kit Kat Club" stripped');
assert(titlesMatch('Show Live', 'Show'),
  '"Live" suffix stripped');
assert(titlesMatch('A Dolls House', "A Doll's House"),
  'Apostrophe variation matches');
assert(titlesMatch('Back to the Future: The Musical', 'Back to the Future'),
  'Colon + The Musical stripped');

// ============================================================================
// cleanSearchTitle
// ============================================================================

console.log('--- cleanSearchTitle ---');

assert(cleanSearchTitle('SIX the Musical') === 'SIX',
  'Strips "the Musical"');
assert(cleanSearchTitle('Deep Azure - Globe') === 'Deep Azure',
  'Strips venue dash suffix');
assert(cleanSearchTitle('Cabaret at the Kit Kat Club') === 'Cabaret',
  'Strips "at the..." suffix');
assert(cleanSearchTitle('Harry Potter And The Cursed Child: Both Parts') === 'Harry Potter And The Cursed Child',
  'Strips ": Both Parts"');
assert(cleanSearchTitle("Disney's Hercules") === 'Hercules',
  'Strips possessive prefix');
assert(cleanSearchTitle('Here There Are Blueberries (Theatre Royal Stratford East)') === 'Here There Are Blueberries',
  'Strips parenthetical venue');
assert(cleanSearchTitle("Jaja\u2019s African Hair Braiding") === "Jaja's African Hair Braiding",
  'Normalizes curly apostrophes');
assert(cleanSearchTitle('Marie & Rosetta') === 'Marie and Rosetta',
  '& → and');
assert(cleanSearchTitle('\u201CHello\u201D') === '"Hello"',
  'Normalizes curly quotes');
assert(cleanSearchTitle('Plain Title') === 'Plain Title',
  'Leaves clean titles unchanged');
assert(cleanSearchTitle('The Boy At The Back Of The Class') === 'The Boy At The Back Of The Class',
  'Does NOT strip "At The Back Of The Class"');
assert(cleanSearchTitle('Andrew Doherty: Sad Gay AIDS Play') === 'Andrew Doherty: Sad Gay AIDS Play',
  'Does NOT strip bare "Play" at end');
assert(cleanSearchTitle('Showstopper! The Improvised Musical') === 'Showstopper! The Improvised Musical',
  'Does NOT strip "Musical" when preceded by non-format word');

// ============================================================================
// Summary
// ============================================================================

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
