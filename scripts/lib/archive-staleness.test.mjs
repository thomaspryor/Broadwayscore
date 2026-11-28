import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parseFetchedDate, isStalePreOpeningArchive: stale } = createRequire(import.meta.url)('./archive-staleness.js');
const now = new Date('2026-11-20');
test('parses Fetched header', () => {
  assert.equal(parseFetchedDate('<!--\nArchive: x\nFetched: 2026-03-01\n-->'), '2026-03-01');
  assert.equal(parseFetchedDate('<!--\n  Archived: 2026-03-01T10:00:00.000Z\n  Source: x\n-->'), '2026-03-01');
  assert.equal(parseFetchedDate('nothing'), null);
});
test('pre-opening archive of closed-window recent show is stale', () => {
  assert.equal(stale({ fetched: '2026-03-01', openingDate: '2026-03-20', now }), true);
});
test('archive fetched 8+ days after opening is fresh', () => {
  assert.equal(stale({ fetched: '2026-03-28', openingDate: '2026-03-20', now }), false);
});
test('window not closed yet -> not stale (avoid refetch loop)', () => {
  assert.equal(stale({ fetched: '2026-11-15', openingDate: '2026-11-18', now }), false);
});
test('old show (>2y) left alone; missing data safe', () => {
  assert.equal(stale({ fetched: '2020-01-01', openingDate: '2020-02-01', now }), false);
  assert.equal(stale({ fetched: null, openingDate: '2026-03-20', now }), false);
});
