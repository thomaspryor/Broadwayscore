// BRO-7779 item 7: real drop times per market from recorded nights; a market with too few nights is labelled a guess.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dp = require('../../scripts/lib/embargo-drop-profiles.js');
const RL = require('../../scripts/lib/readiness-lane.js');

// Broadway in November: market hour 22:00 New York = 03:00Z next day.
const night = (id, openingDate, at, extra = {}) => ({ showId: id, category: 'broadway', openingDate, observed: { at, source: 'observed-cluster', ...extra } });
const bench = { nights: {
  a: night('a', '2026-11-02', '2026-11-03T03:00:00Z'),
  b: night('b', '2026-11-03', '2026-11-04T01:00:00Z'), // two hours early
  c: night('c', '2026-11-04', '2026-11-05T04:00:00Z'),
  d: night('d', '2026-11-05', '2026-11-06T03:00:00Z'),
  e: night('e', '2026-11-06', '2026-11-07T02:30:00Z'),
  est: { showId: 'est', category: 'broadway', openingDate: '2026-11-07', observed: { at: '2026-11-08T03:00:00Z', source: 'estimate' } },
  mid: night('mid', '2026-11-08', '2026-11-09T00:00:00Z', { midnightOnly: true }),
} };
const rows = { b: { rows: [
  { outlet: 'Early Bird', precision: 'exact', publishedTime: '2026-11-04T00:00:00Z' },
  { outlet: 'On Time', precision: 'exact', publishedTime: '2026-11-04T01:02:00Z' },
  { outlet: 'Vague', precision: 'date', publishedTime: '2026-11-03' },
] } };

test('market profile: offsets from the market hour; estimates and midnight-only clusters are not evidence', () => {
  const p = dp.buildProfiles(bench, rows);
  const m = p.markets.broadway;
  assert.equal(m.n, 5);
  assert.deepEqual([m.earliestMin, m.medianMin, m.latestMin, m.earlyNights], [-120, 0, 60, 2]);
  assert.deepEqual(Object.keys(p.earlyOutlets), ['Early Bird']);
  assert.equal(p.earlyOutlets['Early Bird'].maxLeadMin, 60);
});

test('drop window: observed with enough nights, labelled guess without, none for a market with no hour', () => {
  const p = dp.buildProfiles(bench, rows);
  const w = dp.dropWindow({ category: 'off-broadway', openingDate: '2026-11-20' }, p);
  assert.equal(w.basis, 'observed');
  assert.equal(w.fromAt, '2026-11-21T01:00:00.000Z');
  assert.equal(w.toAt, '2026-11-21T04:00:00.000Z');
  assert.match(w.text, /^observed over 5 recorded nights/);
  const g = dp.dropWindow({ category: 'west-end', openingDate: '2026-11-20' }, p);
  assert.equal(g.basis, 'guess');
  assert.match(g.text, /^guess: the market hour 2026-11-20T21:00:00.000Z/);
  assert.equal(dp.dropWindow({ category: 'regional', openingDate: '2026-11-20' }, p).basis, 'none');
  const few = dp.buildProfiles({ nights: { a: bench.nights.a } });
  assert.equal(dp.dropWindow({ category: 'broadway', openingDate: '2026-11-20' }, few).basis, 'guess');
});

test('the real test bench builds a Broadway profile, and the readiness verdict shows it with its basis', () => {
  const p = dp.loadBenchProfiles();
  assert.ok(p && p.markets.broadway && p.markets.broadway.n >= dp.MIN_NIGHTS_FOR_OBSERVED);
  const v = RL.embargoVerdict({ id: 'x-2026', category: 'broadway', openingDate: '2026-11-20' }, Date.parse('2026-11-19T12:00:00Z'));
  assert.match(v.detail, /Drop history: observed over \d+ recorded nights/);
  const we = RL.embargoVerdict({ id: 'y-2026', category: 'west-end', openingDate: '2026-11-20' }, Date.parse('2026-11-19T12:00:00Z'));
  assert.match(we.detail, /Drop history: guess:/);
});
