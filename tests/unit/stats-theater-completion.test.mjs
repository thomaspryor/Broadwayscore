/**
 * theaterCompletion — the house completion ring, checklist and records.
 *
 * Runs the REAL src/lib/stats/theater-completion.ts. The load-bearing rule is
 * that an unmatched venue is NOT a miss: Off-Broadway and West End houses are
 * reported as extra credit so 100% stays reachable, and a London venue sharing
 * a name with a Broadway house must never inflate the ring.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { theaterCompletion } from '../../src/lib/stats/theater-completion';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_META = JSON.parse(readFileSync(join(ROOT, 'data/theater-metadata.json'), 'utf8'));

const META = {
  _meta: { description: 'not a theater' },
  'Booth Theatre': { capacity: 766, yearBuilt: 1913 },
  'Gershwin Theatre': { capacity: 1933, yearBuilt: 1972 },
  'Lena Horne Theatre': { capacity: 1069, yearBuilt: 1926, formerNames: ['Brooks Atkinson Theatre'] },
  'Palace Theatre': { capacity: 1743, yearBuilt: 1913 },
};

const SHOWS = {
  a: { venue: 'Booth Theatre', category: 'broadway' },
  b: { venue: 'Booth Theatre', category: 'broadway' },
  c: { venue: 'Gershwin Theatre', category: 'broadway' },
  former: { venue: 'Brooks Atkinson Theatre', category: 'broadway' },
  london: { venue: 'Palace Theatre', category: 'west-end' },
  offbway: { venue: 'Public Theater', category: 'off-broadway' },
  nofield: { category: 'broadway' },
};

const row = (show_id, date_seen = '2026-01-01') => ({ show_id, rating: '4.0', date_seen });

test('the denominator is the operating houses, excluding the _meta key', () => {
  const r = theaterCompletion([], SHOWS, META);
  assert.equal(r.operating, 4);
  assert.equal(r.houses.length, 4);
  assert.equal(r.houses.filter((h) => h.name === '_meta').length, 0);
  assert.equal(r.visited, 0);
  assert.equal(r.completion, 0);
  assert.equal(r.unvisited.length, 4);
});

test('completion counts distinct houses, not visits', () => {
  const r = theaterCompletion([row('a'), row('b'), row('c')], SHOWS, META);
  assert.equal(r.visited, 2);
  assert.equal(r.completion, 0.5);
  assert.equal(r.houses.find((h) => h.name === 'Booth Theatre').count, 2);
});

test('a former house name counts as a visit to the current house', () => {
  const r = theaterCompletion([row('former')], SHOWS, META);
  const lena = r.houses.find((h) => h.name === 'Lena Horne Theatre');
  assert.equal(lena.visited, true);
  assert.equal(lena.count, 1);
  assert.deepEqual(r.extraCredit, [], 'a rename is a match, not extra credit');
});

test('UNMATCHED VENUES: Off-Broadway and West End become extra credit, not misses', () => {
  const r = theaterCompletion([row('offbway'), row('london')], SHOWS, META);
  assert.equal(r.visited, 0, 'neither is an operating Broadway house');
  assert.equal(r.completion, 0);
  assert.deepEqual(
    r.extraCredit.map((e) => e.venue).sort(),
    ['Palace Theatre', 'Public Theater']
  );
  // The London Palace must NOT tick the Broadway Palace.
  assert.equal(r.houses.find((h) => h.name === 'Palace Theatre').visited, false);
});

test('rows with no venue and no show entry are skipped silently', () => {
  const r = theaterCompletion([row('nofield'), row('ghost-id')], SHOWS, META);
  assert.equal(r.visited, 0);
  assert.deepEqual(r.extraCredit, []);
  assert.equal(r.totalAudience, 0);
});

test('records: home theater, biggest, smallest, oldest', () => {
  const rows = [row('a'), row('b'), row('c'), row('former')];
  const r = theaterCompletion(rows, SHOWS, META);
  assert.equal(r.records.homeTheater.name, 'Booth Theatre', 'most visits');
  assert.equal(r.records.homeTheater.count, 2);
  assert.equal(r.records.biggest.name, 'Gershwin Theatre');
  assert.equal(r.records.smallest.name, 'Booth Theatre');
  assert.equal(r.records.oldest.name, 'Booth Theatre', '1913, and it wins the tie by order');
  // Records only consider VISITED houses.
  assert.ok(r.records.biggest.visited);
});

test('records are null on an empty diary rather than undefined', () => {
  const r = theaterCompletion([], SHOWS, META);
  assert.equal(r.records.homeTheater, null);
  assert.equal(r.records.biggest, null);
  assert.equal(r.records.smallest, null);
  assert.equal(r.records.oldest, null);
});

test('total audience sums the house capacity once per visit', () => {
  const r = theaterCompletion([row('a'), row('b'), row('c')], SHOWS, META);
  assert.equal(r.totalAudience, 766 + 766 + 1933);
});

test('first and last seen track per house, ignoring undated rows', () => {
  const rows = [
    row('a', '2024-05-01'),
    row('a', '2026-02-01'),
    { show_id: 'a', rating: '4.0', date_seen: null },
  ];
  const booth = theaterCompletion(rows, SHOWS, META).houses.find((h) => h.name === 'Booth Theatre');
  assert.equal(booth.count, 3, 'the undated row is still a visit');
  assert.equal(booth.firstSeen, '2024-05-01');
  assert.equal(booth.lastSeen, '2026-02-01');
});

test('houses sort visited-first by count, then alphabetically', () => {
  const r = theaterCompletion([row('a'), row('b'), row('c')], SHOWS, META);
  assert.deepEqual(
    r.houses.map((h) => h.name),
    ['Booth Theatre', 'Gershwin Theatre', 'Lena Horne Theatre', 'Palace Theatre']
  );
  assert.deepEqual(r.unvisited, ['Lena Horne Theatre', 'Palace Theatre']);
});

test('real theater-metadata: 42 operating houses, all with a capacity', () => {
  const r = theaterCompletion([], {}, REAL_META);
  assert.equal(r.operating, Object.keys(REAL_META).filter((k) => !k.startsWith('_')).length);
  assert.ok(r.operating >= 40, `expected ~42 houses, got ${r.operating}`);
  const noCapacity = r.houses.filter((h) => h.capacity === null).map((h) => h.name);
  assert.deepEqual(noCapacity, [], 'total-audience counter needs every capacity');
});
