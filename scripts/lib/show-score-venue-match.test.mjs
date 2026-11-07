import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { pageVenueMatches } = createRequire(import.meta.url)('./show-score-venue-match.js');

test('same venue with operator, blurb, spacing or handle matches', () => {
  assert.ok(pageVenueMatches('Vivian Beaumont Theater – Lincoln Center Theater', 'Vivian Beaumont Theater'));
  assert.ok(pageVenueMatches('Vivian Beaumont Theater, Lincoln Center Theater', 'Vivian Beaumont Theater'));
  assert.ok(pageVenueMatches('The Second City Black Box', 'The Second City Blackbox'));
  assert.ok(pageVenueMatches("Wyndham's Theatre, starring Bryan Cranston in Ivo van Hove’s revival", "Wyndham's Theatre"));
  assert.ok(pageVenueMatches('@sohoplace', 'Soho Place'));
});
test('a different venue still fails', () => {
  assert.equal(pageVenueMatches('Palace Theatre', 'Winter Garden Theatre'), false);
  assert.equal(pageVenueMatches('', 'Winter Garden Theatre'), false);
});
