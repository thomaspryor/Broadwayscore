import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { planPickup } = createRequire(import.meta.url)('./city-finder-daily.js');

const shows = [{ id: 'cyrano-regional-2026', title: 'Cyrano', venue: 'The Old Globe, San Diego, CA', city: 'san-diego-ca' },
  { id: 'cyrano-chicago', title: 'Cyrano', venue: 'The Old Globe, Chicago, IL', city: 'chicago-il' }];
const reviews = [{ showId: 'cyrano-regional-2026', url: 'https://www.example.com/a/' }];
const staged = { productions: [
  { title: 'Cyrano', theatre: 'The Old Globe', start: '2026-07-23', reviews: [
    { url: 'http://example.com/a', outletId: 'x' }, { url: 'https://example.com/b?utm=1', outletId: 'y' },
    { url: 'https://example.com/b', outletId: 'y' }, { url: 'https://example.com/c', outletId: '' } ] },
  { title: 'Brand New', theatre: 'Moxie Theatre', start: '2026-11-01', reviews: [{}, {}, {}] },
  { title: 'Too Few', theatre: 'Moxie Theatre', start: '2026-11-01', reviews: [{}] },
] };

test('only unseen, de-duplicated URLs with an outlet id are planned, for the hub show only', () => {
  const r = planPickup({ staged, shows, reviews, hubSlug: 'san-diego-ca' });
  assert.deepEqual(r.ingest, { 'cyrano-regional-2026': [{ url: 'https://example.com/b?utm=1', outlet: 'y' }] });
});
test('productions with no show become candidates only at the minimum', () => {
  const r = planPickup({ staged, shows, reviews, hubSlug: 'san-diego-ca' });
  assert.deepEqual(r.candidates.map((c) => c.title), ['Brand New']);
});
