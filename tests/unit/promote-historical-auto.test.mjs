// Card #1922 (cousin of card #994/BRO-160, follow-up to #1921): venue write
// sites found by ship-check that skipped sanitizeVenueForWrite() —
// promote-ob-historical.js, promote-historical-we.js, enrich-west-end-shows.js,
// and (found by this card's own adversarial ship-check review)
// enrich-ob-dates-from-showscore.js. Tests the REAL exported functions per
// CLAUDE.md §15 — no logic copies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { buildShowEntry: buildObHistoricalEntry } = require('../../scripts/promote-ob-historical.js');
const { buildShowEntry: buildWeHistoricalEntry } = require('../../scripts/promote-historical-we.js');
const { decideVenueUpdate } = require('../../scripts/enrich-west-end-shows.js');
const { decideOBVenueUpdate } = require('../../scripts/enrich-ob-dates-from-showscore.js');

// --- promote-ob-historical.js ---------------------------------------------

const OB_HISTORICAL_MATCH = {
  title: 'Some Old Play',
  venue: 'Daryl Roth Theatre',
  playbillUrl: 'https://playbill.com/some-old-play',
  parsed: {
    titleParse: { year: 2019 },
    dates: { openingDate: '2019-05-01', firstPreview: '2019-04-20', closingDate: '2019-06-01' },
  },
};

test('promote-ob-historical buildShowEntry: valid venue passes through sanitizeVenueForWrite unchanged', () => {
  const e = buildObHistoricalEntry(OB_HISTORICAL_MATCH);
  assert.equal(e.venue, 'Daryl Roth Theatre');
  assert.equal(e.status, 'closed');
  assert.match(e.id, /-off-broadway-2019$/);
});

test('promote-ob-historical buildShowEntry: a placeholder/neighbourhood-blob venue is refused (venue: null)', () => {
  const e = buildObHistoricalEntry({ ...OB_HISTORICAL_MATCH, venue: 'Midtown E' });
  assert.equal(e.venue, null, 'card #994 write-time guard — main() must skip a null-venue entry');
});

test('promote-ob-historical buildShowEntry: an "Unknown" venue is refused (venue: null)', () => {
  const e = buildObHistoricalEntry({ ...OB_HISTORICAL_MATCH, venue: 'Unknown' });
  assert.equal(e.venue, null);
});

test('promote-ob-historical buildShowEntry: a placeholder titleParse.venue falls back to a real raw r.venue instead of losing the candidate', () => {
  const e = buildObHistoricalEntry({
    ...OB_HISTORICAL_MATCH,
    venue: 'Daryl Roth Theatre',
    parsed: { ...OB_HISTORICAL_MATCH.parsed, titleParse: { ...OB_HISTORICAL_MATCH.parsed.titleParse, venue: 'TBA' } },
  });
  assert.equal(e.venue, 'Daryl Roth Theatre', 'each venue source is sanitized independently before falling back — a placeholder titleParse.venue must not suppress a valid r.venue');
});

test('promote-ob-historical buildShowEntry: both venue sources being placeholders is still refused (venue: null)', () => {
  const e = buildObHistoricalEntry({
    ...OB_HISTORICAL_MATCH,
    venue: 'Unknown',
    parsed: { ...OB_HISTORICAL_MATCH.parsed, titleParse: { ...OB_HISTORICAL_MATCH.parsed.titleParse, venue: 'TBA' } },
  });
  assert.equal(e.venue, null);
});

// --- promote-historical-we.js ----------------------------------------------

const WE_HISTORICAL_CANDIDATE = {
  title: 'Some Old West End Play',
  venue: 'Apollo Theatre',
  season: '2019-2020',
  openingDate: '2019-09-01',
  corroborated: true,
};

test('promote-historical-we buildShowEntry: valid venue passes through sanitizeVenueForWrite unchanged', () => {
  const e = buildWeHistoricalEntry(WE_HISTORICAL_CANDIDATE);
  assert.equal(e.venue, 'Apollo Theatre');
  assert.equal(e.status, 'closed');
  assert.match(e.id, /-west-end-2019$/);
});

test('promote-historical-we buildShowEntry: a placeholder/neighbourhood-blob venue is refused (venue: null)', () => {
  const e = buildWeHistoricalEntry({ ...WE_HISTORICAL_CANDIDATE, venue: 'Midtown W' });
  assert.equal(e.venue, null, 'card #994 write-time guard — main() must skip a null-venue entry');
});

test('promote-historical-we buildShowEntry: a TBD venue is refused (venue: null)', () => {
  const e = buildWeHistoricalEntry({ ...WE_HISTORICAL_CANDIDATE, venue: 'TBD' });
  assert.equal(e.venue, null);
});

// --- enrich-west-end-shows.js decideVenueUpdate -----------------------------

test('decideVenueUpdate: fills in a venue when the show currently has none', () => {
  const r = decideVenueUpdate(null, 'Prince Edward Theatre');
  assert.equal(r.venue, 'Prince Edward Theatre');
  assert.equal(r.reason, null);
});

test('decideVenueUpdate: replaces a TBA/Unknown placeholder venue with a real one', () => {
  assert.equal(decideVenueUpdate('TBA', 'Apollo Theatre').venue, 'Apollo Theatre');
  assert.equal(decideVenueUpdate('Unknown', 'Apollo Theatre').venue, 'Apollo Theatre');
});

test('decideVenueUpdate: leaves an already-real venue alone even when TodayTix disagrees', () => {
  const r = decideVenueUpdate('Apollo Theatre', 'Some Other Theatre');
  assert.equal(r.venue, null);
  assert.equal(r.reason, null);
});

test('decideVenueUpdate: no TodayTix venue is a no-op', () => {
  assert.equal(decideVenueUpdate('TBA', null).venue, null);
  assert.equal(decideVenueUpdate('TBA', '').venue, null);
  assert.equal(decideVenueUpdate('TBA', '   ').venue, null);
});

// Card #1922 (cousin of BRO-160/#1921): the TodayTix venue was written raw
// (tt.venue.trim()) with only a truthiness/TBA/Unknown check — a placeholder
// or neighbourhood-blob string from TodayTix must be refused, not written.
test('decideVenueUpdate: a placeholder/neighbourhood-blob TodayTix venue is refused, not silently promoted', () => {
  const r = decideVenueUpdate('TBA', 'Midtown E');
  assert.equal(r.venue, null, 'card #994 write-time guard — the enrichment loop must skip writing this venue');
  assert.match(r.reason, /failed sanitizeVenueForWrite/);
});

test('decideVenueUpdate: a placeholder TodayTix venue is refused even when replacing "Unknown"', () => {
  const r = decideVenueUpdate('Unknown', 'TBD');
  assert.equal(r.venue, null);
  assert.match(r.reason, /failed sanitizeVenueForWrite/);
});

test('decideVenueUpdate: a "TBD" current venue is also eligible for replacement (canonical placeholder check, not just TBA/Unknown)', () => {
  const r = decideVenueUpdate('TBD', 'Apollo Theatre');
  assert.equal(r.venue, 'Apollo Theatre');
});

// --- enrich-ob-dates-from-showscore.js decideOBVenueUpdate -----------------
// Found by this card's own ship-check adversarial review: the exact
// ShowScore neighbourhood-blob source (venue-classification.js's
// sanitizeVenueForWrite doc comment) still flowed straight into show.venue
// here, unguarded, identical to the 3 sites this card was created to fix.

test('decideOBVenueUpdate: fills in a venue when the show currently has none', () => {
  const r = decideOBVenueUpdate(null, 'Daryl Roth Theatre');
  assert.equal(r.venue, 'Daryl Roth Theatre');
});

test('decideOBVenueUpdate: replaces a TBA placeholder venue with a real one', () => {
  assert.equal(decideOBVenueUpdate('TBA', 'Daryl Roth Theatre').venue, 'Daryl Roth Theatre');
});

test('decideOBVenueUpdate: leaves an already-real venue alone', () => {
  const r = decideOBVenueUpdate('Daryl Roth Theatre', 'Some Other Theatre');
  assert.equal(r.venue, null);
  assert.equal(r.reason, null);
});

test('decideOBVenueUpdate: no ShowScore venue is a no-op', () => {
  assert.equal(decideOBVenueUpdate('TBA', null).venue, null);
  assert.equal(decideOBVenueUpdate('TBA', '').venue, null);
});

test('decideOBVenueUpdate: a placeholder/neighbourhood-blob ShowScore venue is refused, not silently promoted', () => {
  const r = decideOBVenueUpdate('TBA', 'Midtown E');
  assert.equal(r.venue, null, 'card #994 write-time guard — this is the exact ShowScore source that originally motivated it');
  assert.match(r.reason, /failed sanitizeVenueForWrite/);
});
