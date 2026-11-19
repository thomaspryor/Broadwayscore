// BRO-7843: the skeptic reviewer's numbers must reach the daily digest (scripts/health-check.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeSkepticReviewDigest } = require('../lib/skeptic-review-digest.js');
const healthSrc = fs.readFileSync(new URL('../health-check.js', import.meta.url), 'utf8');

test('digest row carries the counts from fixture log rows', () => {
  const r = computeSkepticReviewDigest([
    { outcome: 'block', session: 'a' }, { outcome: 'pass', session: 'a' }, { outcome: 'bypass', session: 'b' },
    { outcome: 'error' }, { outcome: 'over-budget' },
  ]);
  assert.equal(r.name, 'Skeptic review: gate telemetry');
  assert.equal(r.status, 'pass');
  assert.match(r.message, /^Skeptic review: 3 reviews \(1 passed, 1 blocked, 1 would-block over budget\), 1 bypasses, 1 errors, 2 sessions/);
});

test('health-check.js emits the skeptic row into the digest (fails if the wiring is removed)', () => {
  assert.ok(healthSrc.includes('function checkSkepticReview('), 'checkSkepticReview removed');
  assert.ok(/^\s*\.\.\.checkSkepticReview\(\),/m.test(healthSrc), 'checkSkepticReview() is not in the check list');
  assert.ok(healthSrc.includes("require('./lib/skeptic-review-digest.js')"), 'health-check does not use the real digest function');
});

test('checkSkepticReview runs for real and returns one row (unmeasurable where the log is absent)', () => {
  const { checkSkepticReview } = require('../health-check.js');
  const rows = checkSkepticReview();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Skeptic review: gate telemetry');
  assert.ok(['pass', 'warn'].includes(rows[0].status));
});

test('writer logs to the same canonical root the digest reads (worktree rows must not be lost)', () => {
  const src = fs.readFileSync(new URL('../lib/skeptic-review-stop.mjs', import.meta.url), 'utf8');
  assert.match(src, /const LOG = path\.join\(canonicalRoot\(\), '\.cache', 'skeptic-review-stop\.log'\)/);
  assert.match(healthSrc, /infraReviewLedgerRoot\(\), '\.cache', 'skeptic-review-stop\.log'/);
});
