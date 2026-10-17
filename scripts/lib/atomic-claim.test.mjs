import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { acquireClaim, releaseClaim, DEFAULT_STALE_MS } = require('./atomic-claim.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-claim-test-'));
}

test('acquireClaim: first caller wins, a second caller is refused while fresh', () => {
  const dir = tmpDir();
  assert.equal(acquireClaim(dir, 'k1', { now: 1000 }), true);
  assert.equal(acquireClaim(dir, 'k1', { now: 1000 + DEFAULT_STALE_MS - 1 }), false, 'still fresh — genuinely held');
});

test('acquireClaim: a genuinely stale claim is taken over', () => {
  const dir = tmpDir();
  assert.equal(acquireClaim(dir, 'k1', { now: 1000 }), true);
  assert.equal(acquireClaim(dir, 'k1', { now: 1000 + DEFAULT_STALE_MS + 1 }), true, 'past staleMs — takeover');
});

test('releaseClaim frees the key for immediate re-acquisition', () => {
  const dir = tmpDir();
  assert.equal(acquireClaim(dir, 'k1', { now: 1000 }), true);
  releaseClaim(dir, 'k1');
  assert.equal(acquireClaim(dir, 'k1', { now: 1001 }), true);
});

test('BRO-395: a future-dated existing claim is never treated as fresh (never wedges the claim forever)', () => {
  const dir = tmpDir();
  // Held "now" (ms epoch far in the future relative to every later check
  // below) — simulates a corrupt/clock-skewed write, not a legitimate hold.
  const futureHoldMs = Date.now() + 45 * 24 * 60 * 60 * 1000;
  assert.equal(acquireClaim(dir, 'k1', { now: futureHoldMs }), true);
  // A real caller checking moments later, with the real clock, must NOT be
  // told "fresh, held elsewhere" — `now - existing.ts` is deeply negative
  // here, which the old unclamped check (`< staleMs`) would have read as
  // fresh forever, permanently wedging this claim.
  assert.equal(
    acquireClaim(dir, 'k1', { now: Date.now() }),
    true,
    'a future-dated existing claim must be treated as untrustworthy, not fresh — takeover must succeed'
  );
});
