// BRO-243 — canonicalVenue()'s naive first-word fallback (title-match.js)
// silently collapses two unrelated venues that share a leading word ("The
// Duke on 42nd Street" and "The Public Theater" both reduce to "the").
// aggregator-candidate-extract.js's findKnownObShow already fixed this
// locally (task #1246) with venuesMatch() (aliasCanonical + exact
// normalizeVenueName comparison, no lossy fallback). This suite covers the
// generalization of that fix: venuesMatch() now lives in deduplication.js,
// and every other automated-decision consumer of the old canonicalVenue()
// equality (candidate-dedup.js's findExistingMatch, we-historical-
// corroboration.js's recordsAgree) reuses it instead of the lossy fallback.
//
// Run: node --test scripts/lib/canonical-venue-consumers.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { venuesMatch, aliasCanonical } = require('./deduplication.js');
const { canonicalVenue } = require('./title-match.js');
const { findExistingMatch } = require('./candidate-dedup.js');
const { recordsAgree, isCorroborated } = require('./we-historical-corroboration.js');

test('canonicalVenue itself still collapses these to the same first word (documents the bug this suite guards against)', () => {
  assert.equal(canonicalVenue('The Duke on 42nd Street'), canonicalVenue('The Public Theater'));
  assert.equal(canonicalVenue('Prince Edward Theatre'), canonicalVenue('Prince of Wales Theatre'));
});

test('venuesMatch does not collapse unrelated venues sharing a leading word', () => {
  assert.equal(venuesMatch('The Duke on 42nd Street', 'The Public Theater'), false);
  assert.equal(venuesMatch('Prince Edward Theatre', 'Prince of Wales Theatre'), false);
  assert.equal(venuesMatch('Studio Theatre', 'Studio 54'), false);
});

test('venuesMatch still matches real spelling variants of the same venue', () => {
  assert.equal(venuesMatch('Prince Edward Theatre', 'Prince Edward Theatre'), true);
  assert.equal(venuesMatch("St. Luke's Theatre", "St. Luke's Theater"), true);
  assert.equal(venuesMatch('  Prince Edward Theatre  ', 'Prince Edward Theatre'), true);
});

test('venuesMatch still matches curated VENUE_ALIASES pairs (e.g. The New Group / Signature Center)', () => {
  assert.equal(venuesMatch('The New Group', 'Pershing Square Signature Center'), true);
  assert.ok(aliasCanonical('The New Group'));
});

test('candidate-dedup findExistingMatch: a title collision at a DIFFERENT venue sharing a leading word is not a match', () => {
  const candidate = { title: 'Some Fictional Show', venue: 'Prince of Wales Theatre' };
  const existing = [{ id: 'unrelated-show', title: 'Some Fictional Show', venue: 'Prince Edward Theatre' }];
  assert.equal(findExistingMatch(candidate, existing), null);
});

test('candidate-dedup findExistingMatch: still finds a genuine same-venue duplicate', () => {
  const candidate = { title: 'Some Fictional Show', venue: 'Prince Edward Theatre' };
  const existing = [{ id: 'real-dup', title: 'Some Fictional Show', venue: 'Prince Edward Theatre' }];
  const match = findExistingMatch(candidate, existing);
  assert.equal(match?.match.id, 'real-dup');
});

test('we-historical-corroboration recordsAgree: venue collision on a shared leading word does not count as agreement', () => {
  const a = { title: 'Some Fictional Show', venue: 'Prince of Wales Theatre', openingDate: '2024-01-01' };
  const b = { title: 'Some Fictional Show', venue: 'Prince Edward Theatre', openingDate: '2024-01-01' };
  assert.equal(recordsAgree(a, b), false);
});

test('we-historical-corroboration isCorroborated: two venue-colliding-but-unrelated sources do not falsely corroborate', () => {
  const candidate = { title: 'Some Fictional Show', venue: 'Prince of Wales Theatre', openingDate: '2024-01-01' };
  const sources = [
    { source: 'wikipedia', title: 'Some Fictional Show', venue: 'Prince Edward Theatre', openingDate: '2024-01-01' },
    { source: 'olivier-eligibility', title: 'Some Fictional Show', venue: 'Prince Edward Theatre', openingDate: '2024-01-01' },
  ];
  const result = isCorroborated(candidate, sources);
  assert.equal(result.corroborated, false);
  assert.deepEqual(result.agreeingSources, []);
});
