// BRO-4215: shared freshness check behind --skip-fresh-hours in the Reddit and
// Show Score scrapers. Tests require() the real helper (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lastSourceTouchMs, isSourceFresh } = require('./audience-freshness.js');

const now = Date.parse('2026-09-28T12:00:00Z');

test('showScore: fresh only when sources.showScore.lastUpdated is inside the window', () => {
  const rec = (iso) => ({ sources: { showScore: { score: 80, reviewCount: 100, lastUpdated: iso } } });
  assert.equal(isSourceFresh(rec('2026-09-28T01:00:00Z'), 'showScore', 20, { nowMs: now }), true);
  assert.equal(isSourceFresh(rec('2026-09-27T11:00:00Z'), 'showScore', 20, { nowMs: now }), false);
  // Records written before BRO-4215 have no timestamp: never fresh, so they get scraped once and stamped.
  assert.equal(isSourceFresh({ sources: { showScore: { score: 80, reviewCount: 100 } } }, 'showScore', 20, { nowMs: now }), false);
  assert.equal(isSourceFresh({ sources: { showScore: null } }, 'showScore', 20, { nowMs: now }), false);
  assert.equal(isSourceFresh(undefined, 'showScore', 20, { nowMs: now }), false);
  assert.equal(isSourceFresh(rec('2026-09-28T11:00:00Z'), 'showScore', 0, { nowMs: now }), false, 'hours=0 forces a scrape');
});

test('attemptField: the later of the source timestamp and the attempt stamp wins', () => {
  const rec = { sources: { reddit: { lastUpdated: '2026-04-01T00:00:00Z' } }, redditLastAttempted: '2026-09-28T10:00:00Z' };
  assert.equal(lastSourceTouchMs(rec, 'reddit', 'redditLastAttempted'), Date.parse('2026-09-28T10:00:00Z'));
  assert.equal(lastSourceTouchMs(rec, 'reddit'), Date.parse('2026-04-01T00:00:00Z'), 'no attemptField: source timestamp only');
  assert.equal(isSourceFresh(rec, 'reddit', 20, { attemptField: 'redditLastAttempted', nowMs: now }), true);
  // Another source's attempt stamp never makes this source fresh.
  assert.equal(isSourceFresh(rec, 'showScore', 20, { attemptField: 'showScoreLastAttempted', nowMs: now }), false);
});

test('attemptMaxHours: a no-data attempt stamp expires sooner than the data window', () => {
  // Blue Man Group 2026-11-18: no Show Score ratings at 01:06 UTC, 5 ratings by evening.
  const rec = { sources: { showScore: null }, showScoreLastAttempted: '2026-09-28T06:00:00Z' };
  assert.equal(isSourceFresh(rec, 'showScore', 20, { attemptField: 'showScoreLastAttempted', nowMs: now }), true, 'without cap: 6h-old attempt is fresh');
  assert.equal(isSourceFresh(rec, 'showScore', 20, { attemptField: 'showScoreLastAttempted', attemptMaxHours: 4, nowMs: now }), false, '6h-old no-data attempt re-checks under a 4h cap');
  const recent = { ...rec, showScoreLastAttempted: '2026-09-28T10:00:00Z' };
  assert.equal(isSourceFresh(recent, 'showScore', 20, { attemptField: 'showScoreLastAttempted', attemptMaxHours: 4, nowMs: now }), true, '2h-old attempt still skipped');
  // Real data keeps the full window even when the cap is set.
  const data = { sources: { showScore: { score: 80, reviewCount: 5, lastUpdated: '2026-09-28T01:00:00Z' } }, showScoreLastAttempted: '2026-09-27T01:00:00Z' };
  assert.equal(isSourceFresh(data, 'showScore', 20, { attemptField: 'showScoreLastAttempted', attemptMaxHours: 4, nowMs: now }), true);
});
