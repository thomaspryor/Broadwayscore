// Regression test for task #1720: the notion-action-poll.js escalation-off
// kill switch (~/.claude-action-dispatcher/escalation-off) has the same
// no-staleness-alarm gap card #1543 fixed for dispatch-watchdog-off — if
// left engaged by accident, P0/P1 auto-escalation silently stops and
// nothing tells the owner it's been off for days.
//
// notion-action-poll.js reuses (requires, never reimplements — CLAUDE.md
// rule 15) dispatch-watchdog.js's exported pageIfKillSwitchStale, which
// itself is built on dispatch-watchdog-core.js's exported killSwitchStaleness.
// This test exercises those same real, shared functions the wiring in
// notion-action-poll.js calls (scripts/notion-action-poll.js:993-1005) —
// mirrors scripts/tests/dispatch-watchdog-staleness.test.mjs's structure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const core = require('../lib/dispatch-watchdog-core.js');

const NOW = Date.parse('2026-08-18T12:00:00Z');

test('escalation-off kill switch just inside the staleness bar stays silent', () => {
  const mtimeMs = NOW - (core.KILL_SWITCH_STALE_MS - 60 * 1000);
  const { stale, ageMs } = core.killSwitchStaleness(mtimeMs, NOW);
  assert.equal(stale, false);
  assert.ok(ageMs < core.KILL_SWITCH_STALE_MS);
});

test('escalation-off kill switch past the staleness bar fires the alarm', () => {
  const mtimeMs = NOW - (core.KILL_SWITCH_STALE_MS + 60 * 1000);
  const { stale, ageMs } = core.killSwitchStaleness(mtimeMs, NOW);
  assert.equal(stale, true);
  assert.ok(ageMs > core.KILL_SWITCH_STALE_MS);
});

test('no mtime (already cleared) never fires', () => {
  assert.equal(core.killSwitchStaleness(null, NOW).stale, false);
  assert.equal(core.killSwitchStaleness(undefined, NOW).stale, false);
});

// ── integration: real exported pageIfKillSwitchStale (the exact function
// notion-action-poll.js requires from dispatch-watchdog.js), a real file
// (mtime via fs.utimesSync — never the production ~/.claude-action-dispatcher
// path), and a stubbed owner-alert-router so no real digest line is queued.
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

test('pageIfKillSwitchStale: fresh escalation-off file pages nobody', async () => {
  const tmp = path.join(os.tmpdir(), `escalation-off-staleness-test-fresh-${process.pid}`);
  fs.writeFileSync(tmp, '');
  try {
    await withStubbedAlertRouter(async (watchdog, paged) => {
      const { stale } = await watchdog.pageIfKillSwitchStale(tmp, {
        conditionKey: 'escalation-kill-switch-stale', label: 'test switch', clearHint: `rm ${tmp}`,
      });
      assert.equal(stale, false);
      assert.equal(paged.length, 0);
    });
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('pageIfKillSwitchStale: escalation-off file past the bar pages exactly once with the right conditionKey', async () => {
  const tmp = path.join(os.tmpdir(), `escalation-off-staleness-test-stale-${process.pid}`);
  fs.writeFileSync(tmp, '');
  const oldTime = new Date(Date.now() - (core.KILL_SWITCH_STALE_MS + 3600 * 1000));
  fs.utimesSync(tmp, oldTime, oldTime);
  try {
    await withStubbedAlertRouter(async (watchdog, paged) => {
      const { stale, ageMs } = await watchdog.pageIfKillSwitchStale(tmp, {
        conditionKey: 'escalation-kill-switch-stale', label: 'test switch', clearHint: `rm ${tmp}`,
      });
      assert.equal(stale, true);
      assert.ok(ageMs > core.KILL_SWITCH_STALE_MS);
      assert.equal(paged.length, 1);
      assert.equal(paged[0].conditionKey, 'escalation-kill-switch-stale');
    });
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('pageIfKillSwitchStale: missing escalation-off file (already cleared) never pages', async () => {
  const tmp = path.join(os.tmpdir(), `escalation-off-staleness-test-missing-${process.pid}`);
  await withStubbedAlertRouter(async (watchdog, paged) => {
    const { stale } = await watchdog.pageIfKillSwitchStale(tmp, {
      conditionKey: 'escalation-kill-switch-stale', label: 'test switch', clearHint: `rm ${tmp}`,
    });
    assert.equal(stale, false);
    assert.equal(paged.length, 0);
  });
});
