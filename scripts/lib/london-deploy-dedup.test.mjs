// BRO-275: pre-deploy-check.js deleted distinct London productions from the
// deployed shows.json because it deduped on title+category alone. Fixtures are
// the real rows it removed on the 2026-10-04 deploy (run 37204648980).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isSameLondonProduction, findLondonDuplicatesToRemove } = require('./london-deploy-dedup.js');

const row = (id, title, category, venue, status, openingDate, extra = {}) =>
  ({ id, title, category, venue, status, openingDate, ...extra });

const REAL_PAIRS = [
  [row('the-choir-of-man-off-west-end-2026', 'The Choir of Man', 'off-west-end', 'New Wimbledon Theatre', 'closed', '2026-03-14'),
   row('the-choir-of-man-marble-arch-off-west-end-2026', 'The Choir of Man', 'off-west-end', 'The Arts at Marble Arch', 'upcoming', null,
     { previewsStartDate: '2026-12-10', priorRuns: [{ id: 'the-choir-of-man-off-west-end-2026' }] })],
  [row('arcadia-west-end-2026', 'Arcadia', 'west-end', 'The Old Vic', 'closed', '2026-02-04'),
   row('arcadia-duke-of-yorks-west-end-2026', 'Arcadia', 'west-end', "Duke of York's Theatre", 'closed', '2026-07-01',
     { priorRuns: [{ id: 'arcadia-west-end-2026' }] })],
  [row('christmas-carol-goes-wrong-west-end-2026', 'Christmas Carol Goes Wrong', 'west-end', "Wyndham's Theatre", 'upcoming', '2026-12-18',
     { priorRuns: [{ id: 'christmas-carol-goes-wrong-apollo-west-end-2025' }] }),
   row('christmas-carol-goes-wrong-apollo-west-end-2025', 'Christmas Carol Goes Wrong', 'west-end', 'Apollo Theatre', 'closed', '2025-12-14')],
  [row('jane-eyre-off-west-end-2026', 'Jane Eyre', 'off-west-end', 'Southwark Playhouse Elephant', 'open', '2026-09-08'),
   row('jane-eyre-rose-kingston-off-west-end-2026', 'Jane Eyre', 'off-west-end', 'Rose Theatre Kingston', 'upcoming', '2026-10-13')],
  [row('much-ado-about-nothing-globe-off-west-end-2026', 'Much Ado About Nothing', 'off-west-end', 'Globe Theatre', 'open', '2026-06-20'),
   row('much-ado-about-nothing-off-west-end-2026', 'Much Ado About Nothing', 'off-west-end', 'Orange Tree Theatre', 'announced', null)],
];

test('distinct productions sharing a title are never removed (the 5 rows prod lost)', () => {
  const shows = REAL_PAIRS.flat();
  const removed = findLondonDuplicatesToRemove(shows, {});
  assert.deepEqual([...removed], []);
});

test('same venue, different year (returning run) is not a duplicate', () => {
  const a = row('x-2024', 'X', 'off-west-end', 'Globe Theatre', 'closed', '2024-06-01');
  const b = row('x-2026', 'X', 'off-west-end', 'Globe Theatre', 'open', '2026-06-01');
  assert.equal(isSameLondonProduction(a, b), false);
});

test('priorRuns link at the same venue still blocks dedup', () => {
  const a = row('y-a', 'Y', 'west-end', 'Apollo Theatre', 'closed', null);
  const b = row('y-b', 'Y', 'west-end', 'Apollo Theatre', 'upcoming', null, { priorRuns: [{ id: 'y-a' }] });
  assert.equal(isSameLondonProduction(a, b), false);
});

test('a true duplicate row (same title, venue, year) is still removed, keeping the reviewed one', () => {
  const a = row('z-west-end-2026', 'Z', 'west-end', 'Apollo Theatre', 'open', '2026-05-01');
  const b = row('z-apollo-west-end-2026', 'Z', 'west-end', 'Apollo Theatre', 'upcoming', null);
  assert.deepEqual([...findLondonDuplicatesToRemove([a, b], { 'z-west-end-2026': 4 })], ['z-apollo-west-end-2026']);
  assert.deepEqual([...findLondonDuplicatesToRemove([b, a], {})], ['z-apollo-west-end-2026']);
});

test('both sides reviewed: never removed', () => {
  const a = row('w-1', 'W', 'west-end', 'Apollo Theatre', 'open', '2026-05-01');
  const b = row('w-2', 'W', 'west-end', 'Apollo Theatre', 'closed', '2026-05-01');
  assert.deepEqual([...findLondonDuplicatesToRemove([a, b], { 'w-1': 2, 'w-2': 1 })], []);
});

test('a dateless row is not a wildcard: its id year must agree', () => {
  const a = row('v-off-west-end-2025', 'V', 'off-west-end', 'Globe Theatre', 'closed', '2025-06-01');
  const b = row('v-off-west-end-2026', 'V', 'off-west-end', 'Globe Theatre', 'announced', null);
  assert.equal(isSameLondonProduction(a, b), false);
});

test('a TBA discovery stub of the same run is a duplicate (the original Ursula/Krapp shape)', () => {
  const a = row('unfortunate-off-west-end-2026', 'Unfortunate', 'off-west-end', 'The Other Palace - Main Theatre', 'open', '2026-01-10');
  const b = row('unfortunate-west-end-2026', 'unfortunate', 'off-west-end', 'TBA', 'upcoming', null);
  assert.deepEqual([...findLondonDuplicatesToRemove([a, b], {})], ['unfortunate-west-end-2026']);
});

test('room suffix and venue aliases still match', () => {
  const a = row('u-1-2026', 'U', 'off-west-end', 'The Other Palace - Main Theatre', 'open', '2026-01-10');
  const b = row('u-2-2026', 'U', 'off-west-end', 'The Other Palace', 'upcoming', null);
  assert.equal(isSameLondonProduction(a, b), true);
});
