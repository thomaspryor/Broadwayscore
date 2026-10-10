/**
 * BRO-1333 regression tests.
 *
 * main's Test Suite stayed red ~2 days (2026-06-13 -> 06-15) before anyone
 * noticed — the only signal was a daily digest line nobody read in time.
 * scripts/lib/main-red-streak.js's assessMainRedStreak() (the pure predicate)
 * already has full fixture coverage, and scripts/lib/page-worthy-alerts.js
 * has a regression test guarding the escalation tier's page-worthy entry.
 * Neither covers the piece in between: does health-check.js's
 * checkMainRedStreak() actually CALL routeAlert() with the right shape when
 * the predicate alarms, and correctly NOT call it when the predicate is
 * quiet or isCI is false? That wiring had zero test coverage before this
 * file — this mocks routeAlert/cachedShell/hasLowHeadroom (the same pattern
 * scripts/lib/browserbase-session.test.mjs uses) to drive checkMainRedStreak
 * end to end without a real `gh` call.
 *
 * Mocks are installed BEFORE the first require() of health-check.js: it
 * destructures { routeAlert } and { cachedShell, hasLowHeadroom } at module
 * load time, so the mock must already be in place on owner-alert-router.js /
 * gh-api-cache.js's exports for that destructuring to capture it.
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ownerAlertRouter = require('../../scripts/lib/owner-alert-router.js');
const ghApiCache = require('../../scripts/lib/gh-api-cache.js');

let routeAlertCalls = [];
let runListJson = '[]';

mock.method(ownerAlertRouter, 'routeAlert', async (opts) => {
  routeAlertCalls.push(opts);
  return { filed: true };
});
mock.method(ghApiCache, 'cachedShell', () => runListJson);
mock.method(ghApiCache, 'hasLowHeadroom', () => true); // skip the job-detail gh run view branch — not under test here

process.env.GH_TOKEN = 'test-token-for-bro-1333-main-red-streak-alert-test';

const { checkMainRedStreak } = require('../../scripts/health-check.js');

// checkMainRedStreak() anchors assessMainRedStreak() on the real Date.now()
// (not an injectable clock), so `ago()` must be relative to it too — a fixed
// timestamp here silently drifts the "hours ago" math as real time passes.
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const run = (id, headSha, hoursAgo, conclusion) => ({
  databaseId: id,
  headSha,
  createdAt: ago(hoursAgo),
  conclusion,
});

test.beforeEach(() => {
  routeAlertCalls = [];
});

test('a red streak past the 2h threshold pages via routeAlert with the shared conditionKey', async () => {
  runListJson = JSON.stringify([
    run(3, 'ccc333', 1, 'failure'),
    run(2, 'bbb222', 3, 'failure'),
    run(1, 'aaa111', 5, 'failure'),
  ]);

  const results = await checkMainRedStreak(true);

  assert.equal(results[0].status, 'error');
  assert.equal(routeAlertCalls.length, 1, 'routeAlert must fire exactly once');
  const call = routeAlertCalls[0];
  // Same key test.yml's own push-triggered "Detect consecutive main test
  // failures" step uses (.github/workflows/test.yml) — sharing it means both
  // detectors dedup through ONE ledger entry, per the comment above
  // checkMainRedStreak() in scripts/health-check.js.
  assert.equal(call.conditionKey, 'test-yml:main-streak');
  // BRO-3865: 'human' (not 'auto') — test.yml's push-triggered dispatch now
  // files a per-signature 'auto' card per distinct breakage instead of one
  // shared 'auto' card under this key, so this aggregate backstop is the
  // "nobody's per-signature card is stemming a long-running red trunk"
  // human page, same tier as 'test-yml:main-streak-escalation'. It's on
  // page-worthy-alerts.js's allowlist so 'human' isn't silently downgraded
  // to digest.
  assert.equal(call.disposition, 'human');
  assert.equal(call.severity, 'error');
  // 24h, matching the escalation tier — 'auto' never paged more than once
  // per incident (Linear tracker dedupe); 'human' has no such dedupe, only
  // this cooldown, so it must match the escalation tier's cadence rather
  // than the old 6h (which would page every 6h for a condition that can
  // stay open for weeks).
  assert.equal(call.cooldownHours, 24);
  assert.match(call.title, /Main test\.yml red/);
  assert.match(call.description, /main's Test Suite/);
  assert.equal(call.fields.find((f) => f.name === 'First red commit')?.value, 'aaa111');
});

test('a red streak still under the 2h threshold does not page', async () => {
  runListJson = JSON.stringify([
    run(2, 'bbb222', 0.2, 'failure'),
    run(1, 'aaa111', 0.4, 'failure'),
  ]);

  const results = await checkMainRedStreak(true);

  assert.equal(results[0].status, 'pass');
  assert.equal(routeAlertCalls.length, 0, 'a sub-threshold streak must not page');
});

test('a clean green history does not page', async () => {
  runListJson = JSON.stringify([
    run(2, 'bbb222', 0.2, 'success'),
    run(1, 'aaa111', 5, 'failure'),
  ]);

  const results = await checkMainRedStreak(true);

  assert.equal(results[0].status, 'pass');
  assert.equal(routeAlertCalls.length, 0);
});

test('isCI=false never pages even when the streak alarms', async () => {
  runListJson = JSON.stringify([
    run(3, 'ccc333', 1, 'failure'),
    run(2, 'bbb222', 3, 'failure'),
    run(1, 'aaa111', 5, 'failure'),
  ]);

  const results = await checkMainRedStreak(false);

  assert.equal(results[0].status, 'error', 'the row must still report the alarm locally');
  assert.equal(routeAlertCalls.length, 0, 'local/non-CI runs must never dispatch a real alert');
});

test('without GH_TOKEN, the check skips instead of silently reporting healthy', async () => {
  const prevGh = process.env.GH_TOKEN;
  const prevGithub = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const results = await checkMainRedStreak(true);
    assert.equal(results[0].status, 'warn');
    assert.match(results[0].message, /Skipped/);
    assert.equal(routeAlertCalls.length, 0);
  } finally {
    if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
    if (prevGithub !== undefined) process.env.GITHUB_TOKEN = prevGithub;
  }
});
