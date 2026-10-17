import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAcked, addAck, buildScoreboardText, cellKey } = require('./t1-scoreboard.js');

test('cellKey / isAcked round-trip', () => {
  const key = cellKey('show-a', 'nytimes');
  assert.equal(key, 'show-a::nytimes');
  assert.equal(isAcked(key, []), false);
  const acks = addAck([], key, 'known permanent gap', '2026-07-30T00:00:00.000Z');
  assert.equal(isAcked(key, acks), true);
  assert.equal(isAcked('show-a::nypost', acks), false);
});

test('addAck replaces an existing entry for the same key instead of duplicating', () => {
  let acks = addAck([], 'show-a::nytimes', 'first note', '2026-01-01T00:00:00.000Z');
  acks = addAck(acks, 'show-a::nytimes', 'updated note', '2026-02-01T00:00:00.000Z');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].note, 'updated note');
});

test('buildScoreboardText: market lines sorted, formatted as pct (covered/denominator)', () => {
  const marketStats = {
    broadway: { covered: 90, denominator: 100, coveragePct: 90 },
    'off-broadway': { covered: 10, denominator: 20, coveragePct: 50 },
  };
  const { marketLines } = buildScoreboardText(marketStats, { shows: {} }, [], Date.now());
  assert.deepEqual(marketLines, ['broadway: 90% (90/100)', 'off-broadway: 50% (10/20)']);
});

test('buildScoreboardText: null coveragePct (denominator 0) renders as n/a, not NaN%', () => {
  const marketStats = { 'west-end': { covered: 0, denominator: 0, coveragePct: null } };
  const { marketLines } = buildScoreboardText(marketStats, { shows: {} }, [], Date.now());
  assert.deepEqual(marketLines, ['west-end: n/a (0/0)']);
});

test('buildScoreboardText: only GAP cells count as gaps, not IN_FLIGHT/SUPPRESSED/NO_REVIEW_EXPECTED', () => {
  const now = Date.parse('2026-07-30T00:00:00.000Z');
  const ledger = {
    shows: {
      'show-a': {
        title: 'Show A',
        cells: {
          nytimes: { state: 'GAP', firstSeenAt: '2026-07-28T00:00:00.000Z' }, // 48h old
          nypost: { state: 'IN_FLIGHT', firstSeenAt: '2026-07-29T12:00:00.000Z' },
          'hollywood-reporter': { state: 'SUPPRESSED', firstSeenAt: '2026-07-01T00:00:00.000Z' },
          vulture: { state: 'NO_REVIEW_EXPECTED', firstSeenAt: '2026-07-01T00:00:00.000Z' },
        },
      },
    },
  };
  const { oldestGapLines, totalOpenGaps } = buildScoreboardText({}, ledger, [], now);
  assert.equal(totalOpenGaps, 1);
  assert.deepEqual(oldestGapLines, ['Show A — nytimes (48h)']);
});

test('buildScoreboardText: oldest-first ordering + hard cap on lines with an overflow summary', () => {
  const now = Date.parse('2026-07-30T00:00:00.000Z');
  const cells = {};
  for (let i = 0; i < 7; i++) {
    cells[`outlet-${i}`] = { state: 'GAP', firstSeenAt: new Date(now - (i + 1) * 3600000).toISOString() };
  }
  const ledger = { shows: { 'show-a': { title: 'Show A', cells } } };
  const { oldestGapLines, totalOpenGaps } = buildScoreboardText({}, ledger, [], now, { maxOldestGaps: 3 });
  assert.equal(totalOpenGaps, 7);
  assert.equal(oldestGapLines.length, 4); // 3 real lines + 1 overflow summary
  assert.match(oldestGapLines[0], /outlet-6 \(7h\)/); // oldest (largest age) first
  assert.equal(oldestGapLines[3], '… 4 more open gap(s)');
});

test('buildScoreboardText: acked gaps are excluded from the oldest-gap callout and counted separately', () => {
  const now = Date.parse('2026-07-30T00:00:00.000Z');
  const ledger = {
    shows: {
      'show-a': {
        title: 'Show A',
        cells: {
          nytimes: { state: 'GAP', firstSeenAt: '2026-01-01T00:00:00.000Z' }, // ancient, acked
          nypost: { state: 'GAP', firstSeenAt: '2026-07-29T00:00:00.000Z' },  // recent, not acked
        },
      },
    },
  };
  const acks = addAck([], cellKey('show-a', 'nytimes'), 'known dead outlet', now);
  const { oldestGapLines, omittedByAck, totalOpenGaps } = buildScoreboardText({}, ledger, acks, now);
  assert.equal(omittedByAck, 1);
  assert.equal(totalOpenGaps, 1, 'acked gaps do not count toward totalOpenGaps either');
  assert.deepEqual(oldestGapLines, ['Show A — nypost (24h)']);
});

test('buildScoreboardText: empty ledger + empty market stats produces empty text, no throw', () => {
  const { text, marketLines, oldestGapLines } = buildScoreboardText({}, { shows: {} }, [], Date.now());
  assert.equal(text, '');
  assert.deepEqual(marketLines, []);
  assert.deepEqual(oldestGapLines, []);
});

// --- ship-check fix: CIRCUIT_OPEN gets its own visible, capped section -------

test('CIRCUIT_OPEN cells appear in their own scoreboard section, not dropped', () => {
  const ledger = { shows: {
    a: { title: 'A', market: 'broadway', cells: {
      nytimes: { state: 'CIRCUIT_OPEN', firstSeenAt: '2026-06-01T00:00:00.000Z' },
      vulture: { state: 'GAP', firstSeenAt: '2026-07-20T00:00:00.000Z' } } },
    b: { title: 'B', market: 'broadway', cells: {
      ap: { state: 'SUPPRESSED', firstSeenAt: '2026-06-01T00:00:00.000Z' },
      ew: { state: 'IN_FLIGHT', firstSeenAt: '2026-07-29T00:00:00.000Z' } } },
  } };
  const r = buildScoreboardText({ broadway: { covered: 5, denominator: 8, coveragePct: 62.5 } },
    ledger, [], Date.parse('2026-07-30T00:00:00Z'));
  assert.equal(r.totalOpenGaps, 1, 'GAP count unchanged');
  assert.equal(r.totalCircuitOpen, 1, 'circuit-open counted separately');
  assert.equal(r.circuitOpenLines.length, 1);
  assert.match(r.circuitOpenLines[0], /A — nytimes \(\d+h\)/);
  assert.match(r.text, /Circuit open \(retrieval failing across shows — dispatch paused/);
  assert.match(r.text, /Oldest gaps:/, 'the gap section still renders');
  assert.doesNotMatch(r.text, /\bap\b|\bew\b/, 'SUPPRESSED/IN_FLIGHT stay excluded');
});

test('circuit-open list obeys the same hard line cap as the gap list', () => {
  const cells = {};
  for (let i = 0; i < 9; i++) cells[`outlet-${i}`] = { state: 'CIRCUIT_OPEN', firstSeenAt: `2026-06-0${(i % 9) + 1}T00:00:00.000Z` };
  const ledger = { shows: { a: { title: 'A', market: 'broadway', cells } } };
  const r = buildScoreboardText({ broadway: { covered: 1, denominator: 10, coveragePct: 10 } },
    ledger, [], Date.parse('2026-07-30T00:00:00Z'), { maxOldestGaps: 3 });
  assert.equal(r.circuitOpenLines.length, 4, '3 lines + 1 overflow summary');
  assert.match(r.circuitOpenLines[3], /… 6 more circuit-open cell\(s\)/);
  assert.equal(r.totalCircuitOpen, 9);
});

test('acking a circuit-open cell suppresses it from the callout too', () => {
  const ledger = { shows: { a: { title: 'A', market: 'broadway', cells: {
    nytimes: { state: 'CIRCUIT_OPEN', firstSeenAt: '2026-06-01T00:00:00.000Z' } } } } };
  const r = buildScoreboardText({ broadway: { covered: 1, denominator: 2, coveragePct: 50 } },
    ledger, [{ key: 'a::nytimes', ackedAt: 'x', note: 'known dead' }], Date.parse('2026-07-30T00:00:00Z'));
  assert.equal(r.totalCircuitOpen, 0);
  assert.equal(r.omittedByAck, 1);
  assert.deepEqual(r.circuitOpenLines, []);
});
