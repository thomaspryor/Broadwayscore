import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { metaNeedsFetch, errorEntry } = require('../../scripts/lib/census-meta-cache.js');
const D = 86400000;
const now = Date.parse('2026-11-08T00:00:00Z');

test('F16: a fresh error waits, an aged one is retried', () => {
  const e = errorEntry('HTTP 503', null, now - 2 * D);
  assert.equal(e.attempts, 1);
  assert.equal(metaNeedsFetch(e, now - 2 * D + 1000), false);
  assert.equal(metaNeedsFetch(e, now), true);
});
test('F16: backoff grows with attempts and is capped', () => {
  let e = errorEntry('x', null, now - 3 * D);
  e = errorEntry('x', e, now - 3 * D); // attempts 2 -> 2 day wait
  assert.equal(e.attempts, 2);
  assert.equal(metaNeedsFetch(e, now), true);
  const e5 = { error: 'x', errorAt: new Date(now - 10 * D).toISOString(), attempts: 9 };
  assert.equal(metaNeedsFetch(e5, now), false); // capped wait is 14 days
  assert.equal(metaNeedsFetch({ ...e5, errorAt: new Date(now - 15 * D).toISOString() }, now), true);
});
test('F16: legacy untimestamped error is retried; good entries are not', () => {
  assert.equal(metaNeedsFetch({ error: 'HTTP 500' }, now), true);
  assert.equal(metaNeedsFetch({ reviewAuthor: null, title: 't' }, now), false);
  assert.equal(metaNeedsFetch({ title: 't' }, now), true);
  assert.equal(metaNeedsFetch(undefined, now), true);
});

test('F16 wiring: fillMeta decides via metaNeedsFetch, never a bare error check', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/outlet-census.js', import.meta.url), 'utf8');
  assert.match(src, /if \(metaNeedsFetch\(cache\[k\]\)\)/);
  assert.doesNotMatch(src, /!cache\[k\]\.error && !\('reviewAuthor' in cache\[k\]\)/);
});
