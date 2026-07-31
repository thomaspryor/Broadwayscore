/**
 * Task #692: data/audit/bww-roundup-miss-ledger.jsonl (Scraping v2 Sprint 1
 * T6) was write-only — nothing but the write path's own cooldown check ever
 * read it back. summarizeBwwRoundupMisses() (scripts/lib/bww-roundup-
 * persistence.js) is the pure decision function that turns raw ledger
 * entries into a digest-worthy summary; bwwRoundupMissBacklogResults()
 * (scripts/health-check.js) formats that summary into a check result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { summarizeBwwRoundupMisses, OPENING_WINDOW_DAYS, MISS_SUMMARY_WINDOW_HOURS } = require('../../scripts/lib/bww-roundup-persistence.js');
const { bwwRoundupMissBacklogResults } = require('../../scripts/health-check.js');

const NOW = new Date('2026-08-01T00:00:00.000Z').getTime();

test('summarizeBwwRoundupMisses: no entries, no shows, or empty inputs yield nothing', () => {
  assert.deepEqual(summarizeBwwRoundupMisses([], [], NOW), []);
  assert.deepEqual(summarizeBwwRoundupMisses(null, null, NOW), []);
  assert.deepEqual(summarizeBwwRoundupMisses(undefined, undefined, NOW), []);
});

test('summarizeBwwRoundupMisses: a single miss (not 2+) is not flagged', () => {
  const shows = [{ id: 'a', openingDate: '2026-07-30' }]; // 2 days ago, inside window
  const entries = [{ showId: 'a', ts: new Date(NOW - 60 * 60 * 1000).toISOString() }];
  assert.deepEqual(summarizeBwwRoundupMisses(entries, shows, NOW), []);
});

test('summarizeBwwRoundupMisses: 2+ misses inside the opening window are flagged', () => {
  const shows = [{ id: 'a', openingDate: '2026-07-30' }]; // 2 days ago, inside 7-day window
  const entries = [
    { showId: 'a', ts: new Date(NOW - 6 * 60 * 60 * 1000).toISOString() },
    { showId: 'a', ts: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
  ];
  const results = summarizeBwwRoundupMisses(entries, shows, NOW);
  assert.equal(results.length, 1);
  assert.equal(results[0].showId, 'a');
  assert.equal(results[0].missCount, 2);
  assert.equal(results[0].lastMissTs, new Date(NOW - 2 * 60 * 60 * 1000).toISOString());
});

test('summarizeBwwRoundupMisses: 2+ misses OUTSIDE the opening window are NOT flagged (expected cooldown territory)', () => {
  const shows = [{ id: 'a', openingDate: '2026-01-01' }]; // long past opening
  const entries = [
    { showId: 'a', ts: new Date(NOW - 6 * 60 * 60 * 1000).toISOString() },
    { showId: 'a', ts: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
  ];
  assert.deepEqual(summarizeBwwRoundupMisses(entries, shows, NOW), []);
});

test('summarizeBwwRoundupMisses: not-yet-opened shows count as inside the window too', () => {
  const shows = [{ id: 'a', openingDate: '2026-08-03' }]; // opens in 2 days
  const entries = [
    { showId: 'a', ts: new Date(NOW - 6 * 60 * 60 * 1000).toISOString() },
    { showId: 'a', ts: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
  ];
  const results = summarizeBwwRoundupMisses(entries, shows, NOW);
  assert.equal(results.length, 1);
});

test('summarizeBwwRoundupMisses: misses older than the trailing window are excluded from the count', () => {
  const shows = [{ id: 'a', openingDate: '2026-07-30' }];
  const entries = [
    { showId: 'a', ts: new Date(NOW - (MISS_SUMMARY_WINDOW_HOURS + 1) * 60 * 60 * 1000).toISOString() }, // outside window
    { showId: 'a', ts: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() }, // inside window — only 1 counts
  ];
  assert.deepEqual(summarizeBwwRoundupMisses(entries, shows, NOW), []);
});

test('summarizeBwwRoundupMisses: future-timestamped entries (clock skew/corrupt) never count', () => {
  const shows = [{ id: 'a', openingDate: '2026-07-30' }];
  const entries = [
    { showId: 'a', ts: new Date(NOW + 60 * 60 * 1000).toISOString() }, // 1h in the future
    { showId: 'a', ts: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() }, // legit — only 1 counts
  ];
  assert.deepEqual(summarizeBwwRoundupMisses(entries, shows, NOW), []);
});

test('summarizeBwwRoundupMisses: no openingDate on record — cannot confirm window, not flagged (fail-safe, not fail-open)', () => {
  const shows = [{ id: 'a' }];
  const entries = [
    { showId: 'a', ts: new Date(NOW - 6 * 60 * 60 * 1000).toISOString() },
    { showId: 'a', ts: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
  ];
  assert.deepEqual(summarizeBwwRoundupMisses(entries, shows, NOW), []);
});

test('summarizeBwwRoundupMisses: unknown showId (not in shows array) is not flagged', () => {
  const shows = [{ id: 'b', openingDate: '2026-07-30' }];
  const entries = [
    { showId: 'a', ts: new Date(NOW - 6 * 60 * 60 * 1000).toISOString() },
    { showId: 'a', ts: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
  ];
  assert.deepEqual(summarizeBwwRoundupMisses(entries, shows, NOW), []);
});

test('summarizeBwwRoundupMisses: multiple flagged shows sort by missCount desc', () => {
  const shows = [
    { id: 'a', openingDate: '2026-07-30' },
    { id: 'b', openingDate: '2026-07-31' },
  ];
  const entries = [
    { showId: 'a', ts: new Date(NOW - 6 * 60 * 60 * 1000).toISOString() },
    { showId: 'a', ts: new Date(NOW - 2 * 60 * 60 * 1000).toISOString() },
    { showId: 'b', ts: new Date(NOW - 5 * 60 * 60 * 1000).toISOString() },
    { showId: 'b', ts: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() },
    { showId: 'b', ts: new Date(NOW - 1 * 60 * 60 * 1000).toISOString() },
  ];
  const results = summarizeBwwRoundupMisses(entries, shows, NOW);
  assert.equal(results.length, 2);
  assert.equal(results[0].showId, 'b');
  assert.equal(results[0].missCount, 3);
  assert.equal(results[1].showId, 'a');
  assert.equal(results[1].missCount, 2);
});

test('OPENING_WINDOW_DAYS is exported and matches the documented 7-day window', () => {
  assert.equal(OPENING_WINDOW_DAYS, 7);
});

// --- bwwRoundupMissBacklogResults (health-check.js digest formatting) ---

test('bwwRoundupMissBacklogResults: empty or absent summary yields nothing', () => {
  assert.deepEqual(bwwRoundupMissBacklogResults([]), []);
  assert.deepEqual(bwwRoundupMissBacklogResults(null), []);
  assert.deepEqual(bwwRoundupMissBacklogResults(undefined), []);
});

test('bwwRoundupMissBacklogResults: a flagged show warns with count and first show', () => {
  const results = bwwRoundupMissBacklogResults([
    { showId: 'giant-2026', missCount: 3, firstMissTs: '2026-08-01T00:00:00.000Z', lastMissTs: '2026-08-01T06:00:00.000Z' },
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'warn');
  assert.match(results[0].message, /1 show\(s\)/);
  assert.match(results[0].message, /giant-2026 \(3 misses/);
  assert.match(results[0].hint, /bww-roundup-miss-ledger\.jsonl/);
});
