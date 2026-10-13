// BRO-2595: findBestMatch's venue step fell back to EVERY title-matched
// production when the listing's venue matched none of them, then picked one
// by status/date, so an unmodeled Show Score venue spelling could attach a
// URL to the wrong production. It now rejects (the script logs the listing
// to the candidates file for manual review).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { disambiguateByVenue } = require('./lib/show-score-venue-disambiguation.js');
const { venuesMatch } = require('./lib/deduplication.js');

const hamlet2026 = { id: 'hamlet-2026', venue: 'Lyceum Theatre', status: 'open' };
const hamlet2017 = { id: 'hamlet-2017', venue: 'Park Avenue Armory', status: 'closed' };

test('venue that matches none of several productions rejects the listing', () => {
  const r = disambiguateByVenue([hamlet2026, hamlet2017], 'Delacorte Theater', venuesMatch);
  assert.equal(r.rejected, true);
  assert.deepEqual(r.candidates, []);
});

test('venue that matches one production narrows to it', () => {
  const r = disambiguateByVenue([hamlet2026, hamlet2017], 'Park Avenue Armory', venuesMatch);
  assert.equal(r.rejected, false);
  assert.deepEqual(r.candidates.map(s => s.id), ['hamlet-2017']);
});

test('no listing venue, or a single candidate, passes through unchanged', () => {
  assert.deepEqual(disambiguateByVenue([hamlet2026, hamlet2017], null, venuesMatch), { candidates: [hamlet2026, hamlet2017], rejected: false });
  assert.deepEqual(disambiguateByVenue([hamlet2026], 'Delacorte Theater', venuesMatch), { candidates: [hamlet2026], rejected: false });
});

test('a production with no venue on file cannot be ruled out', () => {
  const noVenue = { id: 'hamlet-2030', status: 'upcoming' };
  const r = disambiguateByVenue([hamlet2026, noVenue], 'Delacorte Theater', venuesMatch);
  assert.equal(r.rejected, false);
  assert.deepEqual(r.candidates.map(s => s.id), ['hamlet-2030']);
});
