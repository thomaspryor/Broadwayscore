import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Isolated cache dir — never touch the shared /tmp/bd-serp-negative-cache.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-negcache-test-'));
process.env.BD_SERP_NEGATIVE_CACHE_DIR = DIR;
const negCache = require('./serp-negative-cache.js');

test('page is part of the negative-cache key (sibling of the #872 serp-cache fix)', () => {
  const q = '"Tao of Glass" review';
  const base = { geo: 'gb', dateMin: '', dateMax: '' };

  // An empty page 0 must not answer for pages 1-2, or a deep-page sweep goes
  // blind for the whole 45-min TTL after one shallow miss.
  negCache.set(q, { ...base, page: 0 }, { results: [], provider: 'test' });
  assert.deepEqual(negCache.get(q, { ...base, page: 0 }).results, []);
  assert.equal(negCache.get(q, { ...base, page: 1 }), null);
  assert.equal(negCache.get(q, { ...base, page: 2 }), null);
});

test('negative-cache key fields stay in step with serp-cache', () => {
  // Both caches receive the SAME cacheOpts object from _serpWithChain, so a
  // field present in one key and absent from the other is a silent bug.
  const serpCache = require('./serp-cache.js');
  const q = 'key parity probe';
  const opts = { geo: 'us', dateMin: '2026-01-01', dateMax: '2026-02-01', page: 2 };
  serpCache.set(q, opts, { results: [{ url: 'https://a.example' }], provider: 'test' });
  negCache.set(q, opts, { results: [], provider: 'test' });
  // Same opts minus page must miss in BOTH caches, proving both key on it.
  const noPage = { geo: 'us', dateMin: '2026-01-01', dateMax: '2026-02-01' };
  assert.equal(serpCache.get(q, noPage), null);
  assert.equal(negCache.get(q, noPage), null);
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
