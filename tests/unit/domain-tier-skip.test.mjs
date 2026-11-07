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

  // BRO-3334: hand-authored entries (narrative reason, not the machine-
  // generated "N failures, 0 successes" shape) must survive a regeneration
  // even when they can't be re-derived from this run's stats.
  test('preserves a hand-authored entry with partial success (reason does not match generated pattern)', () => {
    const handAuthored = {
      skip: true,
      reason: 'BRO-3325 (2026-09-14): flipped by the tier-skip drift audit verdict — 3% success over 1551 Scrapingdog calls',
      addedAt: '2026-09-14',
    };
    const existing = { 'didtheylikeit.com': { scrapingdog: handAuthored } };
    // Current run's stats show partial success (47/1551 ~ 3%) — the
    // failures>=threshold && successes===0 branch never fires for this pair.
    const stats = { 'didtheylikeit.com': { scrapingdog: { successes: 47, failures: 1504 } } };
    const out = buildSkipConfig(stats, existing, { skipThreshold: 3, now: '2026-09-21' });
    assert.deepEqual(out['didtheylikeit.com'].scrapingdog, handAuthored);
  });

  test('preserves a hand-authored entry for a domain absent from this run\'s stats entirely', () => {
    const handAuthored = {
      skip: true,
      reason: 'Scraping cost v3 S1-T2 (2026-08-03): production ledger showed 22% success/301 calls over the prior 7d',
      addedAt: '2026-08-03',
    };
    const existing = { 'theatre.reviews': { scrapingdog: handAuthored } };
    // No fetchAttempts recorded for theatre.reviews this run at all.
    const stats = { 'example.com': { brightdata: { successes: 0, failures: 5 } } };
    const out = buildSkipConfig(stats, existing, { skipThreshold: 3, now: '2026-09-21' });
    assert.deepEqual(out['theatre.reviews'].scrapingdog, handAuthored);
  });

  test('a fresh generated entry wins over a stale hand-authored entry on collision', () => {
    const handAuthored = { skip: true, reason: 'old narrative reason', addedAt: '2026-01-01' };
    const existing = { 'example.com': { brightdata: handAuthored } };
    const stats = { 'example.com': { brightdata: { successes: 0, failures: 10 } } };
    const out = buildSkipConfig(stats, existing, { skipThreshold: 3, now: '2026-09-21' });
    assert.equal(out['example.com'].brightdata.reason, '10 failures, 0 successes');
  });

  test('generated entry still refreshes on rebuild (reason matches the machine pattern)', () => {
    const existing = {
      'example.com': { brightdata: { skip: true, reason: '3 failures, 0 successes', addedAt: '2026-01-01' } },
    };
    const stats = { 'example.com': { brightdata: { successes: 0, failures: 5 } } };
    const out = buildSkipConfig(stats, existing, { skipThreshold: 3, now: '2026-09-21' });
    assert.equal(out['example.com'].brightdata.reason, '5 failures, 0 successes');
    assert.equal(out['example.com'].brightdata.addedAt, '2026-01-01', 'addedAt still preserved on refresh');
  });

  test('ignores legacy array-shape existing entries when scanning for hand-authored reasons', () => {
    const existing = { 'example.com': ['brightdata'] };
    const stats = {};
    const out = buildSkipConfig(stats, existing, { skipThreshold: 3, now: '2026-09-21' });
    assert.deepEqual(out, {});
  });
});
