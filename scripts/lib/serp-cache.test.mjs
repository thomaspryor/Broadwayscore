import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// Isolated cache dir per run — never touch the shared /tmp/bd-serp-cache.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'serp-cache-test-'));
process.env.BD_SERP_CACHE_DIR = DIR;
const cache = require('./serp-cache.js');

test('page is part of the cache key (task #872 deep-page regression)', () => {
  const q = '"The Car Man" review';
  const base = { geo: 'gb', dateMin: '', dateMax: '' };

  cache.set(q, { ...base, page: 0 }, { results: [{ url: 'https://p1.example/a' }], provider: 'test' });
  cache.set(q, { ...base, page: 1 }, { results: [{ url: 'https://p2.example/b' }], provider: 'test' });

  // Before the fix, _normOpts dropped `page`, so page 2 read page 1's entry
  // and the paginated census arm silently returned the same ten URLs N times.
  assert.equal(cache.get(q, { ...base, page: 0 }).results[0].url, 'https://p1.example/a');
  assert.equal(cache.get(q, { ...base, page: 1 }).results[0].url, 'https://p2.example/b');
  assert.equal(cache.get(q, { ...base, page: 2 }), null);
});

test('page 0 and an absent page share one key (existing callers keep their entries)', () => {
  const q = 'legacy caller query';
  cache.set(q, { geo: 'us' }, { results: [{ url: 'https://legacy.example/x' }], provider: 'test' });
  assert.equal(cache.get(q, { geo: 'us', page: 0 }).results[0].url, 'https://legacy.example/x');
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
