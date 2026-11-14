// Tests for serpChainOrder — the pure provider-ordering decision behind
// _serpWithChain (SB SERP invisible-burn fix, 2026-07). Requires the REAL
// function per CLAUDE.md rule 15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serpChainOrder, shouldAcceptEmptyScrapingdogSerp, consecutiveFailureBreakerBlocked } = require('./url-discovery.js');

test('default order is BrightData first, ScrapingBee fallback', () => {
  assert.deepEqual(serpChainOrder(false), ['brightdata', 'scrapingbee']);
});

test('preferSpeed flips to ScrapingBee first', () => {
  assert.deepEqual(serpChainOrder(true), ['scrapingbee', 'brightdata']);
});

test('skipping scrapingbee removes SB from the chain (backfill mode)', () => {
  assert.deepEqual(serpChainOrder(false, new Set(['scrapingbee'])), ['brightdata']);
  assert.deepEqual(serpChainOrder(true, new Set(['scrapingbee'])), ['brightdata']);
});

test('skipping brightdata leaves SB only', () => {
  assert.deepEqual(serpChainOrder(false, new Set(['brightdata'])), ['scrapingbee']);
});

test('skipping both yields empty chain (caller must handle)', () => {
  assert.deepEqual(serpChainOrder(false, new Set(['brightdata', 'scrapingbee'])), []);
});

test('unknown skip entries are ignored', () => {
  assert.deepEqual(serpChainOrder(false, new Set(['scrapingdog'])), ['brightdata', 'scrapingbee']);
});

// shouldAcceptEmptyScrapingdogSerp — task #213 empty-authoritative mode.
// Sizing: 10-run CI log sample showed 88% of BD SERP calls were preceded by
// an SD SERP call that SUCCEEDED with 0 organic results, not an SD failure.
//
// Second arg is emptyAuthoritative (default true), NOT preferSpeed — a
// codebase-review pass found opening-night-poller.js (the one flow where
// empty can mean "not published yet") calls with preferSpeed:false, so
// gating on preferSpeed would have left that exact flow unprotected.

test('default (emptyAuthoritative=true): SD success with 0 results is accepted (no BD/SB fallback)', () => {
  assert.equal(shouldAcceptEmptyScrapingdogSerp([], true), true);
});

test('emptyAuthoritative omitted (undefined) defaults to accept, matching _serpWithChain default', () => {
  assert.equal(shouldAcceptEmptyScrapingdogSerp([], undefined), true);
});

test('SD success with results is not the empty-authoritative path', () => {
  assert.equal(shouldAcceptEmptyScrapingdogSerp([{ url: 'https://example.com' }], true), false);
});

test('SD failure (null) always falls through to BD/SB', () => {
  assert.equal(shouldAcceptEmptyScrapingdogSerp(null, true), false);
});

test('emptyAuthoritative:false (opening-night-poller.js): empty SD is NOT authoritative — must still check BD/SB', () => {
  assert.equal(shouldAcceptEmptyScrapingdogSerp([], false), false);
});

test('emptyAuthoritative:false: SD failure (null) still falls through to BD/SB', () => {
  assert.equal(shouldAcceptEmptyScrapingdogSerp(null, false), false);
});

// consecutiveFailureBreakerBlocked — BRO-2939 half-open breaker. Before this
// fix, hitting MAX_CONSECUTIVE_FAILURES latched the provider off for the rest
// of the process: the only way back to closed was a success, but a blocked
// call never got made, so it could never earn one. These cases pin the
// half-open contract that fixes that: blocked while cooling down, exactly one
// probe let through once the cooldown elapses, and `openedAt` bookkeeping
// left entirely to the caller (the function itself never mutates state).

test('under threshold: never blocked, regardless of openedAt', () => {
  assert.deepEqual(consecutiveFailureBreakerBlocked(4, null, 1000, 5, 60000), { blocked: false });
  assert.deepEqual(consecutiveFailureBreakerBlocked(0, 500, 1000, 5, 60000), { blocked: false });
});

test('at threshold, openedAt null: freshly tripped — blocked, caller must record openedAt=now', () => {
  assert.deepEqual(consecutiveFailureBreakerBlocked(5, null, 1000, 5, 60000), { blocked: true, openedAt: 1000 });
});

test('at threshold, still within cooldown: blocked, openedAt unchanged', () => {
  assert.deepEqual(consecutiveFailureBreakerBlocked(5, 1000, 1000 + 59999, 5, 60000), { blocked: true, openedAt: 1000 });
});

test('at threshold, cooldown exactly elapsed: half-open probe allowed, openedAt unchanged', () => {
  assert.deepEqual(consecutiveFailureBreakerBlocked(5, 1000, 1000 + 60000, 5, 60000), { blocked: false, halfOpen: true, openedAt: 1000 });
});

test('at threshold, cooldown long elapsed: still just one probe, not "fully closed"', () => {
  assert.deepEqual(consecutiveFailureBreakerBlocked(5, 1000, 1000 + 600000, 5, 60000), { blocked: false, halfOpen: true, openedAt: 1000 });
});

test('above threshold (failed probe re-entering above 5) behaves the same as exactly-at-threshold', () => {
  assert.deepEqual(consecutiveFailureBreakerBlocked(7, 1000, 1000 + 30000, 5, 60000), { blocked: true, openedAt: 1000 });
  assert.deepEqual(consecutiveFailureBreakerBlocked(7, 1000, 1000 + 60000, 5, 60000), { blocked: false, halfOpen: true, openedAt: 1000 });
});

test('defaults match the module constants (MAX_CONSECUTIVE_FAILURES=5, 10min cooldown) when omitted', () => {
  const now = Date.now();
  assert.deepEqual(consecutiveFailureBreakerBlocked(5, null, now), { blocked: true, openedAt: now });
  assert.deepEqual(consecutiveFailureBreakerBlocked(5, now - 10 * 60 * 1000, now), { blocked: false, halfOpen: true, openedAt: now - 10 * 60 * 1000 });
  assert.deepEqual(consecutiveFailureBreakerBlocked(5, now - 60 * 1000, now), { blocked: true, openedAt: now - 60 * 1000 });
});
