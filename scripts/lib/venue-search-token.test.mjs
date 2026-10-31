// Tests for scripts/lib/venue-search-token.js (BRO-2821).
//
// CLAUDE.md rule 15: this require()s the real function. The independent table
// expectations below are fixtures, not copies of the selection logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { venueSearchToken, STOPWORDS, GENERIC } = require('./venue-search-token.js');

test('the AMAZE case that opened BRO-2821: the leading stopword is not the search term', () => {
  // Old behaviour: 'New World Stages – Stage 5'.split(/[\s\-,—\/]/)[0] === 'New'
  assert.equal(venueSearchToken('New World Stages – Stage 5'), 'World');
});

test('the three stopword families measured in the corpus all resolve to a real word', () => {
  // Frequencies measured against the live corpus 2026-09-05: The x92, St. x60,
  // New x49 — 202 of 2,943 shows with a venue, i.e. 6.9%.
  assert.equal(venueSearchToken('New Amsterdam Theatre'), 'Amsterdam');
  assert.equal(venueSearchToken('St. James Theatre'), 'James');
  assert.equal(venueSearchToken('The Irene Diamond Stage at the Pershing Square Signature Center'), 'Irene');
});

test('a generic venue noun is skipped when something more distinctive follows', () => {
  assert.equal(venueSearchToken('The Griffin Theater at The Shed'), 'Griffin');
  assert.equal(venueSearchToken('Theatre Royal Haymarket'), 'Royal');
});

test('a generic noun is NEVER returned — an empty token beats a word on every Playbill page', () => {
  // 'The Theater Center' is the only venue in the corpus's 355 with no
  // distinctive word at all. Returning 'Theater' here was the defect both
  // adversarial reviewers caught: it matches every playbill.com/production
  // page, so it looks like scoping while scoping nothing. '' omits the venue
  // term and leaves a clean title+market query.
  assert.equal(venueSearchToken('The Theater Center'), '');
});

test('REGRESSION: a generic-sounding word that is actually the venue NAME is kept', () => {
  // An audit (2026-09-05) found 'playhouse' in GENERIC made the West End's
  // "Playhouse Theatre" return '' where the OLD first-token code correctly said
  // "Playhouse" — a strict regression, the one venue where new was worse than
  // old. It had been added for "La Jolla Playhouse", which never needed it:
  // that venue resolves on "Jolla" long before the word is reached.
  assert.equal(venueSearchToken('Playhouse Theatre'), 'Playhouse');
  assert.equal(venueSearchToken('La Jolla Playhouse, La Jolla, CA'), 'Jolla');
});

test('REGRESSION: diacritics are FOLDED, not shredded, when testing membership', () => {
  // The first version lowercased then stripped everything outside [a-z0-9.],
  // which deletes accented characters instead of folding them: "Théâtre"
  // became "thtre", matched nothing in GENERIC, and was returned as though it
  // were distinctive. Caught by tests/unit/sibling-matchers-diacritics.test.mjs
  // as a structural guard, NOT by the live-corpus sweep — no venue in the
  // corpus currently carries an accent, so the sweep was blind to the whole
  // class. That is the lesson: a sweep over today's data cannot prove a
  // matcher correct.
  // Raw spelling is the output contract: fold membership checks, but preserve
  // the selected token's accents and case. A future output-folding change must
  // update these expectations deliberately.
  assert.equal(venueSearchToken('Théâtre du Châtelet'), 'Châtelet');
  assert.equal(venueSearchToken('Théâtre Marigny'), 'Marigny');
  assert.equal(venueSearchToken('Café Carlyle'), 'Carlyle');
  assert.equal(venueSearchToken('Teatro Real'), 'Real');
});

test('a two-character identity is kept, not discarded by the length floor', () => {
  // The regression that a 3-character floor introduced: 'WP Theater' (5 shows)
  // dropped 'WP' and fell through to the generic 'Theater'.
  assert.equal(venueSearchToken('WP Theater'), 'WP');
});

test('a venue whose identity IS the number keeps the number', () => {
  assert.equal(venueSearchToken('Studio 54'), '54');
  assert.equal(venueSearchToken('Stage 42'), '42');
});

test('venues that were already fine are untouched (no-op guarantee)', () => {
  assert.equal(venueSearchToken('Booth Theatre'), 'Booth');
  assert.equal(venueSearchToken('Vivian Beaumont Theater'), 'Vivian');
  assert.equal(venueSearchToken('Playwrights Horizons'), 'Playwrights');
});

test('one-character fragments carry no signal and are not chosen', () => {
  // '5' alone cannot scope anything, and 'Stage' is generic, so neither wins.
  assert.equal(venueSearchToken('Stage 5'), '');
});

test('a venue made only of stopwords and generics yields the empty token', () => {
  assert.equal(venueSearchToken('the cell'), 'cell'); // 'cell' is distinctive
  assert.equal(venueSearchToken('The'), '');
  assert.equal(venueSearchToken('St.'), '');
});

test('empty and missing venues return an empty string rather than throwing', () => {
  assert.equal(venueSearchToken(''), '');
  assert.equal(venueSearchToken(null), '');
  assert.equal(venueSearchToken(undefined), '');
  assert.equal(venueSearchToken('   '), '');
});

// A fixture of REAL venue strings taken verbatim from the live corpus
// (shows.json `venue`), chosen to cover every hard shape the corpus actually
// contains: leading stopword, saint abbreviation, "New" prefix, nested "at
// the" venues, a generic-plus-number identity, a slash-joined double name, and
// a lowercase venue. Not hypotheticals — each of these exists.
const REAL_VENUE_CASES = [
  ['New World Stages – Stage 5', 'World'],
  ['New Amsterdam Theatre', 'Amsterdam'],
  ['New York Theatre Workshop', 'York'],
  ['St. James Theatre', 'James'],
  ['The Irene Diamond Stage at the Pershing Square Signature Center', 'Irene'],
  ['The Griffin Theater at The Shed', 'Griffin'],
  ['The Public Theater', 'Public'],
  ['The Theater Center', ''],
  ['Theatre for a New Audience/Polonsky Shakespeare Center', 'Audience'],
  ['Studio 54', '54'],
  ['Stage 42', '42'],
  ['Booth Theatre', 'Booth'],
  ['the cell', 'cell'],
];

test('CONTRACT: every stopword is skipped before a distinctive venue name', () => {
  // Pin membership independently: iterating only the exported table would
  // silently lose a case when an entry is deleted. This also guards redundant
  // spellings such as "mt.", whose dotless form still excludes it, and "a",
  // which the length floor already excludes.
  assert.deepEqual(STOPWORDS, new Set([
    'a', 'an', 'the', 'at', 'of', 'on', 'in', 'and', 'new',
    'for', 'with', 'from', 'by', 'to', 'its',
    'du', 'de', 'des', 'la', 'le', 'les', 'el', 'il', 'al', 'am',
    'st', 'st.', 'ste', 'ste.', 'mt', 'mt.',
  ]));
  // Use the table as INPUT, with an independently specified output.
  for (const word of STOPWORDS) {
    const venue = `${word} Amsterdam Theatre`;
    assert.equal(venueSearchToken(venue), 'Amsterdam', venue);
  }
  assert.equal(venueSearchToken('Theatre for a New Audience/Polonsky Shakespeare Center'), 'Audience');
});

test('CONTRACT: every generic venue noun yields an empty token', () => {
  assert.deepEqual(GENERIC, new Set([
    'theatre', 'theater', 'theatres', 'theaters',
    'stage', 'stages', 'center', 'centre', 'hall', 'house',
    'studio', 'space', 'room', 'club', 'arts', 'complex', 'auditorium',
    'cafe', 'salle', 'teatro', 'opera',
  ]));
  for (const word of GENERIC) {
    const venue = `The ${word}`;
    assert.equal(venueSearchToken(venue), '', venue);
  }
});

test('REGRESSION GUARD: real venues return the expected first distinctive token', () => {
  // Merely differing from the old first-token result does not prove an
  // improvement: choosing the LAST distinctive token passed that threshold.
  // Pin every result, including venues that should stay unchanged.
  for (const [venue, expected] of REAL_VENUE_CASES) {
    assert.equal(venueSearchToken(venue), expected, venue);
  }
});
