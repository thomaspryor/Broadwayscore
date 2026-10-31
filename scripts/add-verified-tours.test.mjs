// BRO-4601: long-running tours get a hand-checked current-era launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planVerifiedTours } = require('./add-verified-tours.js');

const NOW = new Date('2026-10-05T00:00:00Z');
const parent = { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', type: 'musical', runtime: '2h 45m', synopsis: 'Story.',
  images: { hero: '/images/shows/hamilton-2015/hero.webp', thumbnail: '/images/shows/hamilton-2015/thumbnail.webp', poster: '/images/shows/hamilton-2015/poster.webp' } };
const two = ['https://www.broadwayworld.com/a', 'https://www.kuaf.com/b'];

test('a hand-verified tour is built with its current-era launch and both sources', () => {
  const [p] = planVerifiedTours([{ parent: 'hamilton-2015', launch: '2024-08-16', scheduleSlug: 'hamilton', sources: two }], [parent], NOW);
  assert.equal(p.entry.id, 'hamilton-tour-2024');
  assert.equal(p.entry.openingDate, '2024-08-16');
  assert.equal(p.entry.openingDateSource, 'hand-verified');
  assert.equal(p.entry.tourScheduleSlug, 'hamilton');
  assert.equal(p.entry.runtime, '2h 45m', 'inherits from the Broadway parent');
  for (const u of two) assert.ok(p.entry.tourLaunchEvidence.includes(u));
  assert.doesNotMatch(p.entry.tourLaunchEvidence, /Wikipedia/);
});

test('one source is not enough; a closed tour keeps its closing date', () => {
  assert.match(planVerifiedTours([{ parent: 'hamilton-2015', launch: '2024-08-16', scheduleSlug: 'hamilton', sources: [two[0]] }], [parent], NOW)[0].skip, /two source URLs/);
  const [closed] = planVerifiedTours([{ parent: 'hamilton-2015', launch: '2024-09-21', closing: '2026-07-12', scheduleSlug: 'hamilton', sources: two }], [parent], NOW);
  assert.equal(closed.entry.status, 'closed');
  assert.equal(closed.entry.closingDateSource, 'hand-verified');
});

test('an unknown parent or an existing id is skipped, never created', () => {
  assert.ok(planVerifiedTours([{ parent: 'nope-2000', launch: '2024-08-16', sources: two }], [parent], NOW)[0].skip);
  const existing = { id: 'hamilton-tour-2024', title: 'Hamilton', category: 'tour', tourOf: 'hamilton-2015', openingDate: '2024-08-16', closingDate: null };
  assert.ok(planVerifiedTours([{ parent: 'hamilton-2015', launch: '2024-08-16', sources: two }], [parent, existing], NOW)[0].skip);
});

test('two companies of one title in one list do not both become the same id', () => {
  const plan = planVerifiedTours([
    { parent: 'hamilton-2015', launch: '2024-08-16', scheduleSlug: 'hamilton', sources: two },
    { parent: 'hamilton-2015', launch: '2024-09-21', scheduleSlug: 'hamilton', sources: two },
  ], [parent], NOW);
  assert.ok(plan[0].entry);
  assert.ok(plan[1].skip, 'the second is refused against the first');
});
