/**
 * Unit tests for the gather-reviews.js Pattern Card #4 routing decision —
 * scripts/lib/review-guards.js → shouldRouteUnknownCriticToPending().
 *
 * Regression: Schmigadoon's Talkin' Broadway review (2026-04-22) was stranded
 * in _pending/ because the carve-out only exempted source='serp-discovery'.
 * Direct-URL discoveries (TB tb-direct-url helper) emitted source values like
 * 'direct-url-construction', 'direct-url-index-fallback', and 'direct-url-override'
 * that fell through to the default _pending route.
 *
 * Run: node --test tests/unit/pending-strand-routing.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  isVerifiedDiscoverySource,
  shouldRouteUnknownCriticToPending,
} = require('../../scripts/lib/review-guards.js');

describe('isVerifiedDiscoverySource', () => {
  it('returns true for serp-discovery', () => {
    assert.strictEqual(isVerifiedDiscoverySource('serp-discovery'), true);
  });

  it('returns true for direct-url-construction (TB primary path)', () => {
    assert.strictEqual(isVerifiedDiscoverySource('direct-url-construction'), true);
  });

  it('returns true for direct-url-index-fallback (TB index.html fallback)', () => {
    assert.strictEqual(isVerifiedDiscoverySource('direct-url-index-fallback'), true);
  });

  it('returns true for direct-url-override (TB CLI override)', () => {
    assert.strictEqual(isVerifiedDiscoverySource('direct-url-override'), true);
  });

  it('returns false for rss-discovery (RSS hits often duplicate named-critic files)', () => {
    assert.strictEqual(isVerifiedDiscoverySource('rss-discovery'), false);
  });

  it('returns false for site-search (lower-precision aggregator hits)', () => {
    assert.strictEqual(isVerifiedDiscoverySource('site-search'), false);
  });

  it('returns false for undefined / null / empty source', () => {
    assert.strictEqual(isVerifiedDiscoverySource(undefined), false);
    assert.strictEqual(isVerifiedDiscoverySource(null), false);
    assert.strictEqual(isVerifiedDiscoverySource(''), false);
  });

  it('returns false for non-string source values', () => {
    assert.strictEqual(isVerifiedDiscoverySource(42), false);
    assert.strictEqual(isVerifiedDiscoverySource({}), false);
  });

  it('does not match prefix-only collisions like "direct-urlsomething"', () => {
    // startsWith is intentional — discovery-source naming convention is "direct-url-*",
    // and any future helper using a "direct-url" prefix should be deliberately verified.
    assert.strictEqual(isVerifiedDiscoverySource('direct-urlbogus'), true,
      'startsWith allows any direct-url* — if this becomes a problem, switch to a Set of allowed values');
  });
});

describe('shouldRouteUnknownCriticToPending', () => {
  it('routes unknown critic from rss-discovery to _pending', () => {
    const review = { criticName: 'Unknown', url: 'https://nytimes.com/x', source: 'rss-discovery' };
    assert.strictEqual(shouldRouteUnknownCriticToPending(review), true);
  });

  it('REGRESSION: Schmigadoon TB direct-url-construction does NOT go to _pending', () => {
    const review = {
      criticName: 'Unknown',
      url: 'https://www.talkinbroadway.com/page/world/Schmigadoon.html',
      source: 'direct-url-construction',
    };
    assert.strictEqual(shouldRouteUnknownCriticToPending(review), false,
      'TB direct-URL hits were stranded in _pending on 2026-04-22 — carve-out must exempt direct-url-* sources');
  });

  it('TB direct-url-index-fallback does NOT go to _pending', () => {
    const review = {
      criticName: 'Unknown',
      url: 'https://www.talkinbroadway.com/page/world/index.html',
      source: 'direct-url-index-fallback',
    };
    assert.strictEqual(shouldRouteUnknownCriticToPending(review), false);
  });

  it('SERP discovery at multi-critic outlet does NOT go to _pending (existing carve-out)', () => {
    const review = {
      criticName: 'Unknown',
      url: 'https://www.nytimes.com/2026/04/20/theater/some-review.html',
      source: 'serp-discovery',
    };
    assert.strictEqual(shouldRouteUnknownCriticToPending(review), false);
  });

  it('Named critic never goes to _pending regardless of source', () => {
    const review = { criticName: 'Matthew Murray', url: 'https://x', source: 'rss-discovery' };
    assert.strictEqual(shouldRouteUnknownCriticToPending(review), false);
  });

  it('Unknown critic without URL never goes to _pending (no URL hash to dedupe by)', () => {
    const review = { criticName: 'Unknown', url: null, source: 'rss-discovery' };
    assert.strictEqual(shouldRouteUnknownCriticToPending(review), false);
  });

  it('case-insensitive Unknown match', () => {
    const review = { criticName: 'UNKNOWN', url: 'https://x', source: 'rss-discovery' };
    assert.strictEqual(shouldRouteUnknownCriticToPending(review), true);
    const review2 = { criticName: 'unknown', url: 'https://x', source: 'rss-discovery' };
    assert.strictEqual(shouldRouteUnknownCriticToPending(review2), true);
  });

  it('handles missing/invalid review object gracefully', () => {
    assert.strictEqual(shouldRouteUnknownCriticToPending(null), false);
    assert.strictEqual(shouldRouteUnknownCriticToPending(undefined), false);
    assert.strictEqual(shouldRouteUnknownCriticToPending({}), false);
  });
});
