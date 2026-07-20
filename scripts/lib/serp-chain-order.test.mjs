// Tests for serpChainOrder — the pure provider-ordering decision behind
// _serpWithChain (SB SERP invisible-burn fix, 2026-07). Requires the REAL
// function per CLAUDE.md rule 15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serpChainOrder, shouldAcceptEmptyScrapingdogSerp } = require('./url-discovery.js');

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
