// Tests for scripts/lib/venue-search-token.js (BRO-2821).
//
// CLAUDE.md rule 15: this require()s the real function. It does not restate the
// stopword list — a test carrying its own copy of the table would pass forever
// while the shipped table rotted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { venueSearchToken } = require('./venue-search-token.js');

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
  // 'The Theater Center' and 'Playhouse Theatre' are the only 2 of the corpus's
  // 355 distinct venues with no distinctive word. Returning 'Theater' here was
  // the defect both adversarial reviewers caught: it matches every
  // playbill.com/production page, so it looks like scoping while scoping
  // nothing. '' omits the venue term and leaves a clean title+market query.
  assert.equal(venueSearchToken('The Theater Center'), '');
  assert.equal(venueSearchToken('Playhouse Theatre'), '');
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
const REAL_VENUES = [
  'New World Stages – Stage 5',
  'New Amsterdam Theatre',
  'New York Theatre Workshop',
  'St. James Theatre',
  'The Irene Diamond Stage at the Pershing Square Signature Center',
  'The Griffin Theater at The Shed',
  'The Public Theater',
  'The Theater Center',
  'Theatre for a New Audience/Polonsky Shakespeare Center',
  'Studio 54',
  'Stage 42',
  'Booth Theatre',
  'the cell',
];

// The old implementation, verbatim, so the two can be compared on real shapes.
const oldToken = (venue) => String(venue || '').split(/[\s\-,—/]/)[0];

test('CONTRACT: the token is never a function word — the shape that broke the never-worse promise', () => {
  // Codex adversarial review, 2026-09-05: 'Theatre for a New Audience/Polonsky
  // Shakespeare Center' returned 'for'. It skipped the generic 'Theatre' and
  // landed on a preposition, which is strictly worse than what the old code
  // produced. This is the guard for that whole class, not just that one string.
  const FUNCTION_WORDS = new Set([
    'for', 'and', 'with', 'from', 'by', 'to', 'a', 'an', 'the',
    'at', 'of', 'on', 'in', 'its', 'new',
  ]);
  for (const v of REAL_VENUES) {
    const token = venueSearchToken(v);
    assert.ok(
      !FUNCTION_WORDS.has(token.toLowerCase()),
      `venueSearchToken(${JSON.stringify(v)}) returned the function word ${JSON.stringify(token)}`,
    );
  }
  assert.equal(venueSearchToken('Theatre for a New Audience/Polonsky Shakespeare Center'), 'Audience');
});

test('CONTRACT: the token is never invented and is never a generic venue noun', () => {
  const GENERIC_WORDS = new Set([
    'theatre', 'theater', 'theatres', 'theaters', 'stage', 'stages', 'center',
    'centre', 'hall', 'house', 'playhouse', 'studio', 'space', 'room', 'club',
    'arts', 'complex', 'auditorium',
  ]);
  for (const v of REAL_VENUES) {
    const token = venueSearchToken(v);
    // The token must actually come FROM the venue — never invented.
    assert.ok(v.toLowerCase().includes(token.toLowerCase()), `${token} is not a substring of ${v}`);
    assert.ok(
      !GENERIC_WORDS.has(token.toLowerCase()),
      `venueSearchToken(${JSON.stringify(v)}) returned the generic noun ${JSON.stringify(token)}, which matches every playbill.com/production page`,
    );
  }
});

test('REGRESSION GUARD: the fix still changes the token for the known-bad venues', () => {
  const changed = REAL_VENUES.filter((v) => venueSearchToken(v) !== oldToken(v));
  // 'Booth Theatre' is the one deliberate no-op in the fixture — its first
  // token was already the best single word available. If this figure collapses
  // toward 0 a future edit has silently undone the fix, which is exactly the
  // "absence of a signal looks safe" shape.
  assert.ok(changed.length >= 10, `expected the fix to still improve >=10 real venues, got ${changed.length}`);
  assert.equal(venueSearchToken('Booth Theatre'), oldToken('Booth Theatre'), 'Booth Theatre must stay a no-op');
});
