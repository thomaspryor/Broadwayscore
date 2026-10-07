// timebomb-audit-exempt: "pageIfKillSwitchStale: fresh file pages nobody" writes
//   the kill-switch file with fs.writeFileSync right before asserting, so its
//   mtime is the REAL wall clock. audit-time-bomb-tests.js shifts only the
//   PROCESS clock, so under a shifted run the file reads as artificially old and
//   the assertion flips. Not a real time bomb — production compares two readings
//   of the same real clock (same class as tests/unit/ttl-cache.test.mjs).
//
// Regression test for task #1543: --health must page when the
// dispatch-watchdog-off kill switch has sat engaged past its staleness bar,
// and must stay silent while inside it. Requires the real exported
// core.killSwitchStaleness (CLAUDE.md rule 15) rather than reimplementing
// the threshold math here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const core = require('../lib/dispatch-watchdog-core.js');

const NOW = Date.parse('2026-08-16T12:00:00Z');

test('kill switch just inside the staleness bar stays silent', () => {
  const mtimeMs = NOW - (core.KILL_SWITCH_STALE_MS - 60 * 1000);
  const { stale, ageMs } = core.killSwitchStaleness(mtimeMs, NOW);
  assert.equal(stale, false);
  assert.ok(ageMs < core.KILL_SWITCH_STALE_MS);
});

test('kill switch past the staleness bar fires the alarm', () => {
  const mtimeMs = NOW - (core.KILL_SWITCH_STALE_MS + 60 * 1000);
  const { stale, ageMs } = core.killSwitchStaleness(mtimeMs, NOW);
  assert.equal(stale, true);
  assert.ok(ageMs > core.KILL_SWITCH_STALE_MS);
});

test('the 2026-08-14 incident shape (~66h unattended) fires the alarm', () => {
  const sixtySixHoursMs = 66 * 3600 * 1000;
  const { stale } = core.killSwitchStaleness(NOW - sixtySixHoursMs, NOW);
  assert.equal(stale, true);
});

test('no mtime (env-var-only disable, no backing file) never fires', () => {
  assert.equal(core.killSwitchStaleness(null, NOW).stale, false);
  assert.equal(core.killSwitchStaleness(undefined, NOW).stale, false);
});

test('freshly-touched kill switch (deliberate maintenance window) never fires', () => {
  const { stale } = core.killSwitchStaleness(NOW, NOW);
  assert.equal(stale, false);
});

// ── CLI-layer integration: real exported pageIfKillSwitchStale, a real file
// (mtime set via fs.utimesSync — never the production ~/.claude/state file),
// and a stubbed owner-alert-router so no real digest line is queued (Codex
// ship-check review: "tests miss the integration failures" — this closes
// that gap without touching production state or the live alert digest).
const alertRouterPath = require.resolve('../lib/owner-alert-router.js');
const watchdogPath = require.resolve('../dispatch-watchdog.js');

function withStubbedAlertRouter(fn) {
  const paged = [];
  const prevCacheEntry = require.cache[alertRouterPath];
  require.cache[alertRouterPath] = {
    id: alertRouterPath, filename: alertRouterPath, loaded: true,
    exports: { routeAlert: async opts => { paged.push(opts); return { action: 'digest' }; } },
  };
  delete require.cache[watchdogPath];
  try {
    return fn(require(watchdogPath), paged);
  } finally {
    if (prevCacheEntry) require.cache[alertRouterPath] = prevCacheEntry;
    else delete require.cache[alertRouterPath];
    delete require.cache[watchdogPath];
  }
}

test('pageIfKillSwitchStale: fresh file pages nobody', async () => {
  const tmp = path.join(os.tmpdir(), `watchdog-staleness-test-fresh-${process.pid}.off`);
  fs.writeFileSync(tmp, '');
  try {
    await withStubbedAlertRouter(async (watchdog, paged) => {
      const { stale } = await watchdog.pageIfKillSwitchStale(tmp, {
        conditionKey: 'test-fresh', label: 'test switch', clearHint: `rm ${tmp}`,
      });
      assert.equal(stale, false);
      assert.equal(paged.length, 0);
    });
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('pageIfKillSwitchStale: file past the bar pages exactly once with the right conditionKey', async () => {
  const tmp = path.join(os.tmpdir(), `watchdog-staleness-test-stale-${process.pid}.off`);
  fs.writeFileSync(tmp, '');
  const oldTime = new Date(Date.now() - (core.KILL_SWITCH_STALE_MS + 3600 * 1000));
  fs.utimesSync(tmp, oldTime, oldTime);
  try {
    await withStubbedAlertRouter(async (watchdog, paged) => {
      const { stale, ageMs } = await watchdog.pageIfKillSwitchStale(tmp, {
        conditionKey: 'test-stale', label: 'test switch', clearHint: `rm ${tmp}`,
      });
      assert.equal(stale, true);
      assert.ok(ageMs > core.KILL_SWITCH_STALE_MS);
      assert.equal(paged.length, 1);
      assert.equal(paged[0].conditionKey, 'test-stale');
    });
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('pageIfKillSwitchStale: missing file (already cleared) never pages', async () => {
  const tmp = path.join(os.tmpdir(), `watchdog-staleness-test-missing-${process.pid}.off`);
  await withStubbedAlertRouter(async (watchdog, paged) => {
    const { stale } = await watchdog.pageIfKillSwitchStale(tmp, {
      conditionKey: 'test-missing', label: 'test switch', clearHint: `rm ${tmp}`,
    });
    assert.equal(stale, false);
    assert.equal(paged.length, 0);
  });
});
