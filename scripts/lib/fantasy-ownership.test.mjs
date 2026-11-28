import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computePickOwnership, formatOwnershipPct, MIN_ENTRIES_TO_PUBLISH } = require('./fantasy-ownership.js');

const roster = (...picks) => ({ picks });

test('counts each roster once per show and rounds the share', () => {
  const entries = [
    ...Array.from({ length: 7 }, () => roster('a', 'b')),
    roster('a', 'c'), roster('a', 'a', 'd'), roster('b'),
  ];
  const r = computePickOwnership(entries);
  assert.equal(r.totalEntries, 10);
  assert.equal(r.published, true);
  assert.deepEqual(r.shows.a, { count: 9, pct: 90 }, 'duplicate pick in one roster counts once');
  assert.deepEqual(r.shows.b, { count: 8, pct: 80 });
  assert.deepEqual(r.shows.c, { count: 1, pct: 10 });
  assert.equal(r.shows.zzz, undefined, 'unpicked shows are absent');
});

test('publishes nothing below the privacy floor', () => {
  const r = computePickOwnership(Array.from({ length: MIN_ENTRIES_TO_PUBLISH - 1 }, () => roster('a')));
  assert.equal(r.published, false);
  assert.deepEqual(r.shows, {});
  assert.equal(r.totalEntries, MIN_ENTRIES_TO_PUBLISH - 1);
});

test('ignores malformed entries and pick values', () => {
  const entries = [null, { picks: null }, { picks: 'a' }, roster('a', '', 5), ...Array.from({ length: 9 }, () => roster('b'))];
  const r = computePickOwnership(entries);
  assert.equal(r.totalEntries, 10);
  assert.deepEqual(r.shows.a, { count: 1, pct: 10 });
  assert.equal(r.shows[''], undefined);
  assert.deepEqual(computePickOwnership(undefined), { totalEntries: 0, published: false, shows: {} });
});

test('formatOwnershipPct: <1% for a rare pick, 0% for a show nobody picked', () => {
  const r = computePickOwnership([roster('a'), ...Array.from({ length: 299 }, () => roster('b'))]);
  assert.equal(r.shows.a.pct, 0);
  assert.equal(formatOwnershipPct(r.shows.a), '<1%');
  assert.equal(formatOwnershipPct(r.shows.unpicked), '0%');
  assert.equal(formatOwnershipPct({ count: 42, pct: 42 }), '42%');
});
