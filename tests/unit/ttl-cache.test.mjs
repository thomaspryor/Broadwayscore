/**
 * Tests for scripts/lib/ttl-cache.js — the generic disk-backed TTL cache
 * generalized from serp-cache.js (Scraping v2 Sprint 1 T5). serp-cache.js's
 * own test (serp-cache.test.mjs) covers the SERP-specific wrapper; this file
 * covers the generic primitive directly (construction guards, disabled mode,
 * TTL expiry, multi-instance isolation).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createTtlCache } = require('../../scripts/lib/ttl-cache.js');

const TMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'ttl-cache-test-'));

test('requires dir', () => {
  assert.throws(() => createTtlCache({ ttlMs: 1000 }));
});

test('requires positive ttlMs', () => {
  assert.throws(() => createTtlCache({ dir: TMP_BASE, ttlMs: 0 }));
  assert.throws(() => createTtlCache({ dir: TMP_BASE }));
});

test('cold miss returns null', () => {
  const cache = createTtlCache({ dir: path.join(TMP_BASE, 'a'), ttlMs: 60000 });
  assert.equal(cache.get('anything'), null);
});

test('warm hit returns cached value', () => {
  const cache = createTtlCache({ dir: path.join(TMP_BASE, 'b'), ttlMs: 60000 });
  cache.set('key1', {}, { foo: 'bar' });
  assert.deepEqual(cache.get('key1'), { foo: 'bar' });
});

test('opts distinguish otherwise-identical keys', () => {
  const cache = createTtlCache({ dir: path.join(TMP_BASE, 'c'), ttlMs: 60000 });
  cache.set('key', { market: 'broadway' }, { v: 1 });
  cache.set('key', { market: 'off-broadway' }, { v: 2 });
  assert.deepEqual(cache.get('key', { market: 'broadway' }), { v: 1 });
  assert.deepEqual(cache.get('key', { market: 'off-broadway' }), { v: 2 });
});

test('empty array/object IS cached (a negative result is a valid answer)', () => {
  const cache = createTtlCache({ dir: path.join(TMP_BASE, 'd'), ttlMs: 60000 });
  cache.set('empty', {}, []);
  assert.deepEqual(cache.get('empty'), []);
});

test('null/undefined are NEVER cached', () => {
  const cache = createTtlCache({ dir: path.join(TMP_BASE, 'e'), ttlMs: 60000 });
  cache.set('nullval', {}, null);
  cache.set('undefinedval', {}, undefined);
  assert.equal(cache.get('nullval'), null);
  assert.equal(cache.get('undefinedval'), null);
});

test('entries expire after ttlMs', () => {
  const dir = path.join(TMP_BASE, 'f');
  const cache = createTtlCache({ dir, ttlMs: 50 });
  cache.set('expiring', {}, { v: 1 });
  assert.deepEqual(cache.get('expiring'), { v: 1 });
  const file = fs.readdirSync(dir)[0];
  const old = Date.now() - 1000;
  fs.utimesSync(path.join(dir, file), old / 1000, old / 1000);
  assert.equal(cache.get('expiring'), null, 'entry older than ttlMs must miss');
});

test('disabled:true always misses on get and no-ops on set', () => {
  const dir = path.join(TMP_BASE, 'g');
  const cache = createTtlCache({ dir, ttlMs: 60000, disabled: true });
  cache.set('key', {}, { v: 1 });
  assert.equal(cache.get('key'), null);
  assert.equal(fs.existsSync(dir), false, 'disabled cache must not create its dir');
});

test('two independent instances (different dirs) do not collide', () => {
  const cacheA = createTtlCache({ dir: path.join(TMP_BASE, 'h1'), ttlMs: 60000 });
  const cacheB = createTtlCache({ dir: path.join(TMP_BASE, 'h2'), ttlMs: 60000 });
  cacheA.set('shared-key', {}, { from: 'a' });
  assert.equal(cacheB.get('shared-key'), null);
});

test('stats track hits/misses/writes independently per instance', () => {
  const cache = createTtlCache({ dir: path.join(TMP_BASE, 'i'), ttlMs: 60000 });
  cache.get('miss1');
  cache.set('k', {}, { v: 1 });
  cache.get('k');
  const s = cache.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
  assert.equal(s.writes, 1);
});

test('cleanup tmp cache dir', () => {
  fs.rmSync(TMP_BASE, { recursive: true, force: true });
});
