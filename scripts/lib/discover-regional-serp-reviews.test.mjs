// Pool + query selection for scripts/discover-regional-serp-reviews.js (BRO-4509).
// National tours used to be outside the weekly pool, so nothing searched for
// their reviews; these pin that tours are in and the regional query is unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectDiscoveryShows, buildDiscoveryQuery, buildDiscoveryDateRange } = require('../discover-regional-serp-reviews.js');
const { calculateDateWindow } = require('./url-discovery.js');

const regional = { id: 'purpose-regional-2026', title: 'Purpose', market: 'regional', status: 'open', venue: 'Huntington Theatre Company (Calderwood Pavilion), Boston, MA' };
const tour = { id: 'oh-mary-tour-2026', title: 'Oh, Mary!', market: 'tour', status: 'open', venue: 'North American Tour' };
const oldTour = { id: 'suffs-tour-2025', title: 'Suffs', market: 'tour', status: 'closed', venue: 'North American Tour', closingDate: '2020-01-01' };
const broadway = { id: 'oh-mary-2024', title: 'Oh, Mary!', market: 'broadway', status: 'open', venue: 'Lyceum Theatre' };
const noCity = { id: 'x-regional-2026', title: 'X', market: 'regional', status: 'open', venue: 'Somewhere' };

test('pool includes open regional and tour shows, excludes Broadway and stale closed tours', () => {
  const ids = selectDiscoveryShows([regional, tour, oldTour, broadway], null).map((s) => s.id);
  assert.deepEqual(ids, ['purpose-regional-2026', 'oh-mary-tour-2026']);
});

test('--show filter still restricts to the discovery markets', () => {
  assert.deepEqual(selectDiscoveryShows([tour, broadway], 'oh-mary-tour-2026').map((s) => s.id), ['oh-mary-tour-2026']);
  assert.deepEqual(selectDiscoveryShows([tour, broadway], 'oh-mary-2024'), []);
});

test('regional query keeps the city form; tour query names the tour', () => {
  assert.equal(buildDiscoveryQuery(regional), '"Purpose" review Boston');
  assert.equal(buildDiscoveryQuery(tour), '"Oh, Mary!" national tour review');
  assert.equal(buildDiscoveryQuery(noCity), null);
});

test('long-running tour gets a rolling window; regional keeps the shared window', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const longTour = { ...tour, id: 'book-of-mormon-tour-2022', openingDate: '2022-08-31' };
  const r = buildDiscoveryDateRange(longTour, now);
  assert.equal(r.dateMax.toISOString().slice(0, 10), '2026-11-01');
  assert.equal(r.dateMin.toISOString().slice(0, 10), '2026-06-04');
  const closed = buildDiscoveryDateRange({ ...longTour, closingDate: '2026-09-01' }, now);
  assert.equal(closed.dateMax.toISOString().slice(0, 10), '2026-10-01');
  const reg = { ...regional, openingDate: '2026-09-10' };
  assert.deepEqual(buildDiscoveryDateRange(reg, now), calculateDateWindow(reg));
});
