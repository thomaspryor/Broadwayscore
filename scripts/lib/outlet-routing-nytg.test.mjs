// Regression test for card #116: normalizeOutlet('New York Theater Guide')
// was routing to 'vulture' (an unrelated T1 outlet) because vulture's
// generic "new york" alias matched as a fuzzy outlet-critic prefix. Covers
// both spellings plus a general no-cross-family-token-overlap guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeOutlet } = require('./review-normalization.js');

test('New York Theater Guide (American spelling) routes to nytg, not vulture', () => {
  assert.equal(normalizeOutlet('New York Theater Guide'), 'nytg');
});

test('New York Theatre Guide (British spelling) routes to nytg', () => {
  assert.equal(normalizeOutlet('New York Theatre Guide'), 'nytg');
});

test('vulture retains its own exact-match aliases', () => {
  assert.equal(normalizeOutlet('Vulture'), 'vulture');
  assert.equal(normalizeOutlet('New York Magazine'), 'vulture');
  assert.equal(normalizeOutlet('New York'), 'vulture');
});

test('no-cross-family regression: other "New York <outlet>" names do not collide with vulture', () => {
  const cases = {
    'New York Theater': 'nyt-theater',
    'New York Stage Review': 'nysr',
    'New York Classical Review': 'new-york-classical-review',
    'New York City Theatre': 'new-york-city-theatre',
    'New York Sun': 'new-york-sun',
    'New York Daily News': 'nydailynews',
    'New York Post': 'nypost',
    'New York Times': 'nytimes',
    'Time Out New York': 'timeout',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(normalizeOutlet(input), expected, `"${input}" should route to ${expected}`);
  }
});

test('legit concatenated outlet-critic patterns still resolve (fuzzy prefix loop unaffected for non-ambiguous aliases)', () => {
  assert.equal(normalizeOutlet('variety-frank-rizzo'), 'variety');
  assert.equal(normalizeOutlet('newyorkmagazinevulture-sara-holdren'), 'vulture');
});
