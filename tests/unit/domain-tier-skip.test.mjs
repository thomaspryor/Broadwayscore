/**
 * Tests for scripts/lib/domain-tier-skip.js (Scraping v2 Sprint 1 T10):
 * dual-schema read path + addedAt-preserving skip-config builder.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getSkippedTiers, buildSkipConfig } = require('../../scripts/lib/domain-tier-skip.js');

describe('getSkippedTiers', () => {
  test('reads new-shape provenance entries', () => {
    const config = {
      'example.com': {
        scrapingdog: { skip: true, reason: '3 failures, 0 successes', addedAt: '2026-07-30' },
      },
    };
    assert.deepEqual(getSkippedTiers(config, 'example.com'), new Set(['scrapingdog']));
  });

  test('reads legacy array-shape entries', () => {
    const config = { 'example.com': ['brightdata', 'playwright'] };
    assert.deepEqual(getSkippedTiers(config, 'example.com'), new Set(['brightdata', 'playwright']));
  });

  test('ignores entries with skip:false', () => {
    const config = { 'example.com': { scrapingdog: { skip: false, reason: 'reinstated', addedAt: '2026-07-30' } } };
    assert.deepEqual(getSkippedTiers(config, 'example.com'), new Set());
  });

  test('returns empty set for unknown domain', () => {
    assert.deepEqual(getSkippedTiers({}, 'unknown.com'), new Set());
  });

  test('returns empty set for null/undefined config', () => {
    assert.deepEqual(getSkippedTiers(null, 'example.com'), new Set());
    assert.deepEqual(getSkippedTiers(undefined, 'example.com'), new Set());
  });
});

describe('buildSkipConfig', () => {
  test('skips domain+tier at or above threshold with 0 successes', () => {
    const stats = { 'example.com': { brightdata: { successes: 0, failures: 3 } } };
    const out = buildSkipConfig(stats, {}, { skipThreshold: 3, now: '2026-07-30' });
    assert.equal(out['example.com'].brightdata.skip, true);
    assert.equal(out['example.com'].brightdata.addedAt, '2026-07-30');
    assert.match(out['example.com'].brightdata.reason, /3 failures, 0 successes/);
  });

  test('does not skip below threshold', () => {
    const stats = { 'example.com': { brightdata: { successes: 0, failures: 2 } } };
    const out = buildSkipConfig(stats, {}, { skipThreshold: 3, now: '2026-07-30' });
    assert.equal(out['example.com'], undefined);
  });

  test('does not skip when there are any successes', () => {
    const stats = { 'example.com': { brightdata: { successes: 1, failures: 5 } } };
    const out = buildSkipConfig(stats, {}, { skipThreshold: 3, now: '2026-07-30' });
    assert.equal(out['example.com'], undefined);
  });

  test('preserves addedAt from an existing new-shape entry across regenerations', () => {
    const stats = { 'example.com': { brightdata: { successes: 0, failures: 5 } } };
    const existing = { 'example.com': { brightdata: { skip: true, reason: 'old reason', addedAt: '2026-01-01' } } };
    const out = buildSkipConfig(stats, existing, { skipThreshold: 3, now: '2026-07-30' });
    assert.equal(out['example.com'].brightdata.addedAt, '2026-01-01', 'addedAt must not be re-stamped');
  });

  test('stamps addedAt=now for a legacy array-shape prior entry (no per-tier provenance to preserve)', () => {
    const stats = { 'example.com': { brightdata: { successes: 0, failures: 5 } } };
    const existing = { 'example.com': ['brightdata'] };
    const out = buildSkipConfig(stats, existing, { skipThreshold: 3, now: '2026-07-30' });
    assert.equal(out['example.com'].brightdata.addedAt, '2026-07-30');
  });

  test('output keys are sorted for stable diffs', () => {
    const stats = {
      'zzz.com': { brightdata: { successes: 0, failures: 5 } },
      'aaa.com': { brightdata: { successes: 0, failures: 5 } },
    };
    const out = buildSkipConfig(stats, {}, { skipThreshold: 3, now: '2026-07-30' });
    assert.deepEqual(Object.keys(out), ['aaa.com', 'zzz.com']);
  });
});
