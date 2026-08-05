// Guard unit test (S0-T3, card 3b2637c5/#994).
//
// requires() the real isPlaceholderVenue (scripts/audit-placeholder-venues.js)
// and the write-time guard sanitizeVenueForWrite (scripts/lib/venue-classification.js)
// that reuses it — never re-derive the predicate in a test (CLAUDE.md §15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { isPlaceholderVenue, NEIGHBOURHOOD_BLOBS } = require('../../scripts/audit-placeholder-venues.js');
const { sanitizeVenueForWrite } = require('../../scripts/lib/venue-classification.js');
const { resolveTodayTixVenue } = require('../../scripts/discover-new-shows.js');

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

// S0 remainder (card #994): resolveTodayTixVenue is the previously-leaking
// write path — discover-new-shows.js's consumeShowScoreCandidatesFile
// ttConfirmed branch and the raw off-broadway TodayTix listing loop both
// wrote `ttShow.venue` / `show.venue` straight through with NO guard call
// at all, unlike the ShowScore-scrape path traced in S0-T2. That's exactly
// how jest-to-impress-off-broadway-2026 landed with venue:"Soho/Tribeca" —
// TodayTix's own venue field returned a neighbourhood blob. Both call
// sites now route through this shared helper.
test('resolveTodayTixVenue (the leaking write path) rejects the exact blob that leaked', () => {
  assert.equal(resolveTodayTixVenue({ venue: 'Soho/Tribeca' }), null);
  assert.equal(resolveTodayTixVenue({ venue: { name: 'Soho/Tribeca' } }), null);
  assert.equal(resolveTodayTixVenue({ venue: 'TBA' }), null);
  assert.equal(resolveTodayTixVenue({ venue: null }), null);
  assert.equal(resolveTodayTixVenue({}), null);
});

test('resolveTodayTixVenue accepts real venues in either TodayTix shape', () => {
  assert.equal(resolveTodayTixVenue({ venue: "St. Ann's Warehouse" }), "St. Ann's Warehouse");
  assert.equal(resolveTodayTixVenue({ venue: { name: 'The Public Theater' } }), 'The Public Theater');
});

// Card #1060: same class as #994, but for the Broadway and West End write
// sites in discover-new-shows.js — fetchShowsFromTodayTix's Broadway loop
// and fetchShowsFromTodayTixLondon's WE loop both wrote `show.venue` straight
// through with `|| 'TBA'`, no guard at all. Both loops now route through
// this same resolveTodayTixVenue helper (already covered above), so these
// cases just confirm it behaves identically regardless of which loop calls
// it — Broadway/WE shows aren't a special case the guard could miss.
test('resolveTodayTixVenue (Broadway/WE write sites, card #1060) rejects placeholder venues', () => {
  assert.equal(resolveTodayTixVenue({ venue: 'TBA' }), null);
  assert.equal(resolveTodayTixVenue({ venue: { name: 'TBA' } }), null);
  assert.equal(resolveTodayTixVenue({ venue: 'Midtown W' }), null);
});

test('resolveTodayTixVenue (Broadway/WE write sites, card #1060) accepts real Broadway/WE houses', () => {
  assert.equal(resolveTodayTixVenue({ venue: 'Hudson Theatre' }), 'Hudson Theatre');
  assert.equal(resolveTodayTixVenue({ venue: { name: 'Trafalgar Theatre' } }), 'Trafalgar Theatre');
});

// The OLT/LT JSON-LD scrapers and the Broadway.org HTML fallback (card #1060)
// don't go through resolveTodayTixVenue (they're not TodayTix-shaped), but
// they all route their raw scraped venue through sanitizeVenueForWrite
// directly — already exercised above (line 61-81). These cases confirm the
// specific values those sites can produce (a bare JSON-LD location object's
// `.name`, or a missing `<a>` link that .textContent?.trim()s to '') fail
// closed the same way.
test('sanitizeVenueForWrite (OLT/LT/Broadway.org write sites, card #1060) rejects blank/placeholder scrape results', () => {
  assert.equal(sanitizeVenueForWrite(undefined), null); // no venueLink found on the page
  assert.equal(sanitizeVenueForWrite('TBA'), null); // JSON-LD location missing, old code did `|| 'TBA'`
});

// Card #1060 follow-up (/what-else finding): scripts/discover-historical-shows.js
// had the exact same `venue: venue || 'TBA'` leak in its IBDB season-table
// scraper — a live CI writer (discover-historical-shows.yml), not covered by
// #994 or the rest of #1060 since it's a wholly separate discovery pipeline.
// The function isn't exported (no clean unit-test seam without a heavier
// jsdom fixture), so this is a wiring test in the same spirit as
// discover-historical-shows-category.test.mjs: verify the guard is actually
// imported and called, and that the raw `|| 'TBA'` string is gone.
test('discover-historical-shows.js routes its venue write through sanitizeVenueForWrite (card #1060 follow-up)', () => {
  const src = readFileSync(join(import.meta.dirname, '../../scripts/discover-historical-shows.js'), 'utf8');
  assert.ok(
    /require\(['"]\.\/lib\/venue-classification['"]\)/.test(src),
    'discover-historical-shows.js no longer imports scripts/lib/venue-classification — the venue guard was removed'
  );
  assert.ok(
    /sanitizeVenueForWrite\(/.test(src),
    'discover-historical-shows.js no longer calls sanitizeVenueForWrite — the venue write is unguarded again'
  );
  assert.ok(
    !/venue:\s*venue\s*\|\|\s*'TBA'/.test(src),
    'discover-historical-shows.js still has the raw `venue: venue || \'TBA\'` leak'
  );
});
