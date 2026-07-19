// Tests for serpChainOrder — the pure provider-ordering decision behind
// _serpWithChain (SB SERP invisible-burn fix, 2026-07). Requires the REAL
// function per CLAUDE.md rule 15.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serpChainOrder } = require('./url-discovery.js');

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
