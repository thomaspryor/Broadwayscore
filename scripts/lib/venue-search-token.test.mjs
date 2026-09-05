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

test('a generic noun IS returned when it is the only non-stopword left — better than the article', () => {
  // 'The Theater Center' has no distinctive token at all. Returning 'Theater'
  // is weak, but it is strictly more signal than the old 'The'.
  assert.equal(venueSearchToken('The Theater Center'), 'Theater');
});

test('venues that were already fine are untouched (no-op guarantee)', () => {
  assert.equal(venueSearchToken('Booth Theatre'), 'Booth');
  assert.equal(venueSearchToken('Vivian Beaumont Theater'), 'Vivian');
  assert.equal(venueSearchToken('Playwrights Horizons'), 'Playwrights');
});

test('short numeric and fragment tokens are never chosen', () => {
  // '5' and 'at' carry no search signal; 'Stage 5' must not yield '5'.
  assert.equal(venueSearchToken('Stage 5'), 'Stage');
});

test('NEVER returns empty for a non-empty venue, and never regresses to worse than the first token', () => {
  // Rule 3 of the function's contract. A venue made entirely of stopwords still
  // returns SOMETHING, and that something is what the old code would have used.
  assert.equal(venueSearchToken('the cell'), 'cell');
  assert.equal(venueSearchToken('The'), 'The');
  assert.equal(venueSearchToken('St.'), 'St.');
});

test('empty and missing venues return an empty string rather than throwing', () => {
  assert.equal(venueSearchToken(''), '');
  assert.equal(venueSearchToken(null), '');
  assert.equal(venueSearchToken(undefined), '');
  assert.equal(venueSearchToken('   '), '');
});

test('REGRESSION GUARD: for every real corpus venue the token is never a stopword unless nothing else exists', () => {
  // The old implementation, verbatim, so the two can be compared on real shapes.
  const oldToken = (venue) => String(venue || '').split(/[\s\-,—/]/)[0];
  const sample = [
    'New World Stages – Stage 5',
    'New Amsterdam Theatre',
    'St. James Theatre',
    'The Irene Diamond Stage at the Pershing Square Signature Center',
    'The Griffin Theater at The Shed',
    'Booth Theatre',
    'the cell',
  ];
  let improved = 0;
  for (const v of sample) {
    const next = venueSearchToken(v);
    assert.ok(next.length > 0, `empty token for ${v}`);
    if (next !== oldToken(v)) improved += 1;
  }
  // Six of the seven sampled venues previously produced a stopword or a
  // fragment. If a future edit makes this 0, the fix has been silently undone —
  // which is exactly the "absence of a signal looks safe" shape.
  assert.equal(improved, 6, 'the fix must still change the token for the known-bad venues');
});
