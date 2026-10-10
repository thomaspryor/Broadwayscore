/**
 * Tests for scripts/lib/serp-negative-cache-policy.js (Scraping v2 Sprint 1 T11).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { serpNegativeCacheTtlMs, NEGATIVE_CACHE_TTL_MS } = require('../../scripts/lib/serp-negative-cache-policy.js');

describe('serpNegativeCacheTtlMs', () => {
  test('returns null for Broadway — never negative-cache in-window', () => {
    assert.equal(serpNegativeCacheTtlMs({ category: 'broadway' }), null);
  });

  test('returns 45min for off-broadway', () => {
    assert.equal(serpNegativeCacheTtlMs({ category: 'off-broadway' }), 45 * 60 * 1000);
    assert.equal(serpNegativeCacheTtlMs({ category: 'off-broadway' }), NEGATIVE_CACHE_TTL_MS);
  });

  test('returns 45min for west-end', () => {
    assert.equal(serpNegativeCacheTtlMs({ category: 'west-end' }), NEGATIVE_CACHE_TTL_MS);
  });

  test('returns 45min for off-west-end (grouped with west-end)', () => {
    assert.equal(serpNegativeCacheTtlMs({ category: 'off-west-end' }), NEGATIVE_CACHE_TTL_MS);
  });

  test('returns null for unknown/null category (fail-safe toward freshness)', () => {
    assert.equal(serpNegativeCacheTtlMs({ category: null }), null);
    assert.equal(serpNegativeCacheTtlMs({}), null);
    assert.equal(serpNegativeCacheTtlMs(null), null);
    assert.equal(serpNegativeCacheTtlMs(undefined), null);
  });

  test('returns null for an unrecognized category string', () => {
    assert.equal(serpNegativeCacheTtlMs({ category: 'regional' }), null);
  });
});
