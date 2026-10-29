// BRO-6516: the weekly regional SERP run searches a rotating slice once the
// pool outgrows what fits in the job timeout. Pins: every show lands in exactly
// one slice, no slice exceeds the cap, and consecutive weeks cover the pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { weeklySlice } = require('../discover-regional-serp-reviews.js');

const pool = (n) => Array.from({ length: n }, (_, i) => ({ id: `show-${String(i).padStart(3, '0')}` }));
const WEEK = 7 * 86400000;

test('a pool under the cap is searched whole', () => {
  const r = weeklySlice(pool(12), new Date(), 30);
  assert.equal(r.shows.length, 12);
  assert.equal(r.slices, 1);
});

test('a 204-show pool splits into 7 slices of at most 30 that cover every show once', () => {
  const shows = pool(204);
  const seen = new Map();
  for (let w = 0; w < 7; w++) {
    const r = weeklySlice(shows, new Date(w * WEEK), 30);
    assert.equal(r.slices, 7);
    assert.ok(r.shows.length <= 30, `slice ${w} has ${r.shows.length}`);
    for (const s of r.shows) seen.set(s.id, (seen.get(s.id) || 0) + 1);
  }
  assert.equal(seen.size, 204);
  assert.ok([...seen.values()].every((c) => c === 1));
});

test('input order does not change the slice', () => {
  const shows = pool(90);
  const now = new Date(3 * WEEK);
  const a = weeklySlice(shows, now, 30).shows.map((s) => s.id);
  const b = weeklySlice([...shows].reverse(), now, 30).shows.map((s) => s.id);
  assert.deepEqual(a, b);
});
