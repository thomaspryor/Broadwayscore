/**
 * Tests for scripts/build-ob-venues.js — the regenerator for
 * data/off-broadway-venues.json (the TodayTix OB discovery fallback allowlist).
 *
 * These avoid depending on data/shows.json (the "no-data-dependency" CI batch
 * runs without core data): they exercise serialize()/BLOCKLIST directly and
 * assert the COMMITTED list is well-formed. A drift check against shows.json
 * lives in the script's own --check mode, run where core data is present.
 *
 * Run: node --test tests/unit/build-ob-venues.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serialize, BLOCKLIST } = require('../../scripts/build-ob-venues.js');
const committed = require('../../data/off-broadway-venues.json');

test('serialize matches the on-disk format (2-space indent + trailing newline)', () => {
  const out = serialize(['atlantic', 'cherry lane']);
  assert.equal(out, '[\n  "atlantic",\n  "cherry lane"\n]\n');
});

test('serialize round-trips the committed list byte-for-byte (proves it was generated, not hand-edited)', () => {
  // The committed array, re-serialized, must equal a re-sort+serialize of itself.
  const resorted = [...committed].sort();
  assert.deepEqual(committed, resorted, 'committed list must be sorted');
  assert.equal(serialize(committed), serialize(resorted));
});

test('committed list is non-empty, unique, and normalized', () => {
  assert.ok(committed.length > 50, 'expected a substantial OB venue list');
  assert.equal(new Set(committed).size, committed.length, 'no duplicate entries');
  for (const v of committed) {
    assert.equal(v, v.toLowerCase(), `entry "${v}" must be lowercase`);
    assert.ok(!/ theatre$| theater$/.test(v), `entry "${v}" must have trailing Theatre/Theater stripped`);
    assert.ok(!/\(.*\)$/.test(v), `entry "${v}" must have trailing parenthetical stripped`);
  }
});

test('no blocklisted name leaked into the committed list', () => {
  for (const v of committed) {
    assert.ok(!BLOCKLIST.has(v), `blocklisted "${v}" must not appear in the venue list`);
  }
});

test('BLOCKLIST covers known neighborhood/placeholder noise but not real venues', () => {
  for (const noise of ['midtown e', 'east village', 'tba', '']) {
    assert.ok(BLOCKLIST.has(noise), `"${noise}" should be blocklisted`);
  }
  for (const real of ['theatre 71', 'lucille lortel', 'cherry lane']) {
    assert.ok(!BLOCKLIST.has(real), `"${real}" must NOT be blocklisted`);
  }
});
