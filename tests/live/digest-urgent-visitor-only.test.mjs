/**
 * LIVE recheck for BRO-3444 (RECHECK-AFTER 2026-10-14): the daily health
 * snapshot that CI writes (data/audit/health-digest-snapshot.json on
 * origin/main) says URGENT only when a visitor-facing error is open. Before
 * the fix it said "BSC URGENT (day 61)" for an internal-only error set.
 * Fails on a snapshot older than the fix (it would prove nothing).
 *
 *   node --test tests/live/digest-urgent-visitor-only.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyHealthCheck } = require('../../scripts/lib/digest-audience.js');
const FIX_LANDED = '2026-10-13T12:41:00Z';
// First data-health-check run after the fix (06:45 UTC cron, can run late).
const FIRST_SNAPSHOT_DUE = '2026-10-14T12:00:00Z';

test('URGENT in the health snapshot only with a visitor-facing error', (t) => {
  execSync('git fetch -q origin main', { stdio: 'ignore' });
  const snap = JSON.parse(execSync('git show origin/main:data/audit/health-digest-snapshot.json', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  // Before the first post-fix snapshot is due there is nothing to check yet
  // (land.yml runs changed test files); after it, a stale one is a failure.
  if (snap.generatedAt <= FIX_LANDED && new Date().toISOString() < FIRST_SNAPSHOT_DUE) {
    t.skip(`snapshot ${snap.generatedAt} predates the fix; due by ${FIRST_SNAPSHOT_DUE}`);
    return;
  }
  assert.ok(snap.generatedAt > FIX_LANDED, `snapshot ${snap.generatedAt} predates the fix; wait for the next data-health-check run`);
  const visitor = (snap.errors || []).filter((e) => classifyHealthCheck(e) === 'visitors');
  if (/URGENT/.test(snap.subject || '')) {
    assert.ok(visitor.length > 0, `URGENT with only internal errors: ${snap.subject}`);
  }
});
