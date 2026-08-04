// Guard unit test (S0-T3, card 3b2637c5/#994).
//
// requires() the real isPlaceholderVenue (scripts/audit-placeholder-venues.js)
// and the write-time guard sanitizeVenueForWrite (scripts/lib/venue-classification.js)
// that reuses it — never re-derive the predicate in a test (CLAUDE.md §15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPlaceholderVenue, NEIGHBOURHOOD_BLOBS } = require('../../scripts/audit-placeholder-venues.js');
const { sanitizeVenueForWrite } = require('../../scripts/lib/venue-classification.js');

test('isPlaceholderVenue rejects TBA/unknown markers', () => {
  for (const v of ['TBA', 'tba', 'TBD', 'N/A', 'na', 'unknown', '', '-', '  TBA  ']) {
    assert.equal(isPlaceholderVenue(v).placeholder, true, `expected "${v}" to be a placeholder`);
  }
});

test('isPlaceholderVenue rejects neighbourhood blobs (case/whitespace-insensitive)', () => {
  for (const v of ['Midtown E', 'midtown e', 'Midtown W', 'Midtown East', 'Midtown West',
    'Greenwich V', 'Greenwich Village', 'Soho/Tribeca', 'Soho / Tribeca', '  Soho/Tribeca  ',
    'East Village', 'West Village', 'Upper W Side', 'Upper E Side', 'Brooklyn', 'Queens', 'Harlem']) {
    assert.equal(isPlaceholderVenue(v).placeholder, true, `expected "${v}" to be a placeholder`);
  }
});

test('isPlaceholderVenue rejects scraped junk text', () => {
  assert.equal(isPlaceholderVenue('Please check your confirmation email for address').placeholder, true);
  assert.equal(isPlaceholderVenue('See website for details').placeholder, true);
});

test('isPlaceholderVenue rejects missing/null/non-string values', () => {
  assert.equal(isPlaceholderVenue(null).placeholder, true);
  assert.equal(isPlaceholderVenue(undefined).placeholder, true);
  assert.equal(isPlaceholderVenue(42).placeholder, true);
});

test('isPlaceholderVenue ACCEPTS real venues that substring-match a neighbourhood blob', () => {
  // The exact-match design (not substring) is the whole point: these three
  // are real venue names containing a neighbourhood word and must pass.
  for (const v of ['West Village Musical Theatre Festival', 'East Village Basement', 'Brooklyn Academy of Music']) {
    const result = isPlaceholderVenue(v);
    assert.equal(result.placeholder, false, `expected "${v}" to be accepted, got reason: ${result.reason}`);
  }
});

test('isPlaceholderVenue accepts ordinary named venues', () => {
  for (const v of ['Circle in the Square Theatre', 'St. Ann\'s Warehouse', 'The Public Theater', 'Playwrights Horizons']) {
    assert.equal(isPlaceholderVenue(v).placeholder, false, `expected "${v}" to be accepted`);
  }
});

test('NEIGHBOURHOOD_BLOBS set matches the documented blob values', () => {
  assert.ok(NEIGHBOURHOOD_BLOBS.has('midtown e'));
  assert.ok(NEIGHBOURHOOD_BLOBS.has('soho/tribeca'));
});

test('sanitizeVenueForWrite (write-time guard) fails closed on blob venues', () => {
  for (const v of ['TBA', 'Midtown E', 'Soho/Tribeca']) {
    assert.equal(sanitizeVenueForWrite(v), null, `expected "${v}" to be rejected at write time`);
  }
});

test('sanitizeVenueForWrite accepts real venues, including neighbourhood-word substrings', () => {
  for (const v of ['West Village Musical Theatre Festival', 'East Village Basement', 'Brooklyn Academy of Music']) {
    assert.equal(sanitizeVenueForWrite(v), v);
  }
});

test('sanitizeVenueForWrite trims whitespace on accepted venues', () => {
  assert.equal(sanitizeVenueForWrite('  The Public Theater  '), 'The Public Theater');
});

test('sanitizeVenueForWrite fails closed on missing values', () => {
  assert.equal(sanitizeVenueForWrite(null), null);
  assert.equal(sanitizeVenueForWrite(undefined), null);
  assert.equal(sanitizeVenueForWrite(''), null);
});
