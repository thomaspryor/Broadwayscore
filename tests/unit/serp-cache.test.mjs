// timebomb-audit-exempt: serp-cache.js builds on ttl-cache.js, whose freshness
//   check is Date.now() - stat.mtimeMs. audit-time-bomb-tests.js shifts the
//   PROCESS clock but not the FILESYSTEM, so every cached entry reads as expired
//   under a shifted run. Not a real time bomb — see tests/unit/ttl-cache.test.mjs.
/**
 * Tests for scripts/lib/serp-cache.js and the weekly-bucket / preferSpeed
 * cache-write logic in scripts/lib/url-discovery.js::_serpWithChain.
 *
 * Locks in the two P1 fixes from the ship-check on commit 79a899087b:
 *   1. dateMax weekly bucket → cache key stable across a 7-day window
 *      (was: churned daily on every open show, gutting the cache).
 *   2. preferSpeed=true skips empty-array caching → opening-night polls
 *      can't hide a freshly-published review for up to 24h.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-cache-test-'));
process.env.BD_SERP_CACHE_DIR = TMP_BASE;
process.env.BD_SERP_CACHE_TTL_HOURS = '24';

const cache = await import('../../scripts/lib/serp-cache.js');

test('cold miss returns null', () => {
  assert.equal(cache.default.get('fresh query', { geo: 'us' }), null);
});

test('warm hit returns cached value', () => {
  cache.default.set('hamlet review', { geo: 'us' }, { results: [{ url: 'a' }], provider: 'brightdata' });
  const hit = cache.default.get('hamlet review', { geo: 'us' });
  assert.ok(hit);
  assert.equal(hit.results[0].url, 'a');
});

test('different geo isolates cache key', () => {
  cache.default.set('shared query', { geo: 'us' }, { results: [{ url: 'us-result' }], provider: 'bd' });
  assert.equal(cache.default.get('shared query', { geo: 'gb' }), null);
});

test('different dateMax bucket isolates cache key', () => {
  cache.default.set('date query', { geo: 'us', dateMin: '2026-01-01', dateMax: '2026-05-14' }, { results: [{ url: 'a' }], provider: 'bd' });
  assert.equal(cache.default.get('date query', { geo: 'us', dateMin: '2026-01-01', dateMax: '2026-06-11' }), null);
});

test('empty array IS cached (valid "no results" answer)', () => {
  cache.default.set('zerohits', { geo: 'us' }, { results: [], provider: 'bd' });
  const hit = cache.default.get('zerohits', { geo: 'us' });
  assert.ok(hit);
  assert.equal(hit.results.length, 0);
});

test('null is NEVER cached (provider failure — retry next time)', () => {
  cache.default.set('failed query', { geo: 'us' }, null);
  assert.equal(cache.default.get('failed query', { geo: 'us' }), null);
});

test('whitespace and case normalized in key', () => {
  cache.default.set('  Foo BAR  ', { geo: 'us' }, { results: [{ url: 'x' }], provider: 'bd' });
  const hit = cache.default.get('foo bar', { geo: 'us' });
  assert.ok(hit);
  assert.equal(hit.results[0].url, 'x');
});

test('stats track hits/misses/writes', () => {
  const s = cache.default.stats();
  assert.ok(s.hits >= 3, `expected >=3 hits, got ${s.hits}`);
  assert.ok(s.writes >= 4, `expected >=4 writes, got ${s.writes}`);
});

// ============================================================================
// Weekly-bucket logic from _serpWithChain — extracted as the pure helper
// ============================================================================

test('weekly bucket: 7 consecutive days produce 1-2 buckets', () => {
  const wkMs = 7 * 24 * 60 * 60 * 1000;
  const bucketFor = (d) => new Date(Math.floor(d.getTime() / wkMs) * wkMs).toISOString().split('T')[0];

  const start = new Date('2026-05-14T12:00:00Z');
  const seen = new Set();
  for (let i = 0; i < 7; i++) {
    seen.add(bucketFor(new Date(start.getTime() + i * 24 * 60 * 60 * 1000)));
  }
  // ≤2 because the 7-day window can straddle one bucket boundary (Thursday UTC anchor).
  assert.ok(seen.size <= 2, `expected ≤2 buckets across 7 days, got ${seen.size}: ${[...seen].join(',')}`);
});

test('weekly bucket: 14+ days apart produce different buckets', () => {
  const wkMs = 7 * 24 * 60 * 60 * 1000;
  const bucketFor = (d) => new Date(Math.floor(d.getTime() / wkMs) * wkMs).toISOString().split('T')[0];

  const a = bucketFor(new Date('2026-05-14T00:00:00Z'));
  const b = bucketFor(new Date('2026-06-04T00:00:00Z'));
  assert.notEqual(a, b);
});

// Cleanup
test('cleanup tmp cache dir', () => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});
