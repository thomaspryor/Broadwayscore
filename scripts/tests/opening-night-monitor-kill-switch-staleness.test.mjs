// timebomb-audit-exempt: "pageIfKillSwitchStale: fresh KILL_FILE pages nobody"
//   writes the kill-switch file with fs.writeFileSync right before asserting, so
//   its mtime is the REAL wall clock. audit-time-bomb-tests.js shifts only the
//   PROCESS clock, so under a shifted run the file reads as artificially old and
//   the assertion flips. Not a real time bomb — production compares two readings
//   of the same real clock (same class as tests/unit/ttl-cache.test.mjs and
//   dispatch-watchdog-staleness.test.mjs).
//
// Regression test for task #1777 (card #1773): opening-night-monitor-launch.js's
// KILL_FILE/ON_MONITOR_DISABLED kill switch has the same no-staleness-alarm gap
// card #1543 fixed for dispatch-watchdog-off and card #1720 fixed for
// notion-action-poll.js's escalation-off — if KILL_FILE is left in place by
// accident, ALL opening-night monitoring silently stops and nothing tells the
// owner it's been off for days.
//
// opening-night-monitor-launch.js reuses (requires, never reimplements —
// CLAUDE.md rule 15) dispatch-watchdog.js's exported pageIfKillSwitchStale,
// which itself is built on dispatch-watchdog-core.js's exported
// killSwitchStaleness. This test exercises those same real, shared functions
// the wiring in opening-night-monitor-launch.js calls — mirrors
// scripts/tests/notion-action-poll-escalation-staleness.test.mjs's structure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const core = require('../lib/dispatch-watchdog-core.js');

const NOW = Date.parse('2026-08-18T12:00:00Z');
const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('opening-night-monitor-launch.js wires KILL_FILE through pageIfKillSwitchStale', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'opening-night-monitor-launch.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/dispatch-watchdog\.js['"]\)/, 'must import pageIfKillSwitchStale from dispatch-watchdog.js');
  assert.match(src, /pageIfKillSwitchStale\(\s*KILL_FILE/, 'must call pageIfKillSwitchStale with the KILL_FILE path');
  assert.match(src, /conditionKey:\s*['"]on-monitor-kill-switch-stale['"]/, 'must use a conditionKey distinct from watchdog-kill-switch-stale / escalation-kill-switch-stale');
});

// Mirrors #1720's fix exactly: the check must run before the gates that could
// otherwise blind it — a stuck lock or a broken auth env must not also stop
// the ONE mechanism meant to catch the kill switch going stale.
test('the staleness check runs before preflightAuth() and the lock mkdir gate', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'opening-night-monitor-launch.js'), 'utf8');
  const stalenessIdx = src.indexOf('pageIfKillSwitchStale(');
  // indexOf('preflightAuth()') would match either the call site in main() or
  // the function DEFINITION further up — anchor on the call site specifically
  // (`const auth = preflightAuth();`).
  const authCallIdx = src.indexOf('const auth = preflightAuth();');
  const lockMkdirIdx = src.indexOf('fs.mkdirSync(LOCK_DIR, { recursive: false });');
  assert.ok(stalenessIdx > -1 && authCallIdx > -1 && lockMkdirIdx > -1, 'expected all three markers to be present');
  assert.ok(stalenessIdx < authCallIdx, 'staleness check must run before preflightAuth() — a broken auth env must not blind the alarm');
  assert.ok(stalenessIdx < lockMkdirIdx, 'staleness check must run before the lock mkdir gate — a stuck lock must not blind the alarm');
});

test('the staleness check is skipped on --dry-run (documented as printing the decision, launching nothing)', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'opening-night-monitor-launch.js'), 'utf8');
  const guardIdx = src.indexOf("if (!opts['dry-run']) {");
  const stalenessIdx = src.indexOf('pageIfKillSwitchStale(');
  assert.ok(guardIdx > -1 && guardIdx < stalenessIdx, "pageIfKillSwitchStale call must be inside an `if (!opts['dry-run'])` block");
});

// Follow-up fix (Codex adversarial review, task #1773): the first cut ran
// the staleness check before the --heartbeat and --active-shows early
// returns, so those documented side-effect-free utility modes ("print
// in-window show ids") could write to the real alert ledger. Source-text-
// locks the check running AFTER both early returns.
test('the staleness check runs after the --heartbeat and --active-shows early returns', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'opening-night-monitor-launch.js'), 'utf8');
  const heartbeatIdx = src.indexOf('if (opts.heartbeat) {');
  const activeShowsIdx = src.indexOf("if (opts['active-shows']) {");
  const stalenessIdx = src.indexOf('pageIfKillSwitchStale(');
  assert.ok(heartbeatIdx > -1 && activeShowsIdx > -1 && stalenessIdx > -1, 'expected all three markers to be present');
  assert.ok(heartbeatIdx < stalenessIdx, '--heartbeat must stay side-effect-free — its early return must precede the staleness check');
  assert.ok(activeShowsIdx < stalenessIdx, '--active-shows must stay side-effect-free — its early return must precede the staleness check');
});

test('KILL_FILE just inside the staleness bar stays silent', () => {
  const mtimeMs = NOW - (core.KILL_SWITCH_STALE_MS - 60 * 1000);
  const { stale, ageMs } = core.killSwitchStaleness(mtimeMs, NOW);
  assert.equal(stale, false);
  assert.ok(ageMs < core.KILL_SWITCH_STALE_MS);
});

test('KILL_FILE past the staleness bar fires the alarm', () => {
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
// opening-night-monitor-launch.js requires from dispatch-watchdog.js), a real
// file (mtime via fs.utimesSync — never the production
// data/opening-night-monitor/DISABLED path), and a stubbed owner-alert-router
// so no real digest line is queued.
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

test('pageIfKillSwitchStale: fresh KILL_FILE pages nobody', async () => {
  const tmp = path.join(os.tmpdir(), `on-monitor-kill-switch-staleness-test-fresh-${process.pid}`);
  fs.writeFileSync(tmp, '');
  try {
    await withStubbedAlertRouter(async (watchdog, paged) => {
      const { stale } = await watchdog.pageIfKillSwitchStale(tmp, {
        conditionKey: 'on-monitor-kill-switch-stale', label: 'test switch', clearHint: `rm ${tmp}`,
      });
      assert.equal(stale, false);
      assert.equal(paged.length, 0);
    });
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('pageIfKillSwitchStale: KILL_FILE past the bar pages exactly once with the right conditionKey', async () => {
  const tmp = path.join(os.tmpdir(), `on-monitor-kill-switch-staleness-test-stale-${process.pid}`);
  fs.writeFileSync(tmp, '');
  const oldTime = new Date(Date.now() - (core.KILL_SWITCH_STALE_MS + 3600 * 1000));
  fs.utimesSync(tmp, oldTime, oldTime);
  try {
    await withStubbedAlertRouter(async (watchdog, paged) => {
      const { stale, ageMs } = await watchdog.pageIfKillSwitchStale(tmp, {
        conditionKey: 'on-monitor-kill-switch-stale', label: 'test switch', clearHint: `rm ${tmp}`,
      });
      assert.equal(stale, true);
      assert.ok(ageMs > core.KILL_SWITCH_STALE_MS);
      assert.equal(paged.length, 1);
      assert.equal(paged[0].conditionKey, 'on-monitor-kill-switch-stale');
    });
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('pageIfKillSwitchStale: missing KILL_FILE (already cleared) never pages', async () => {
  const tmp = path.join(os.tmpdir(), `on-monitor-kill-switch-staleness-test-missing-${process.pid}`);
  await withStubbedAlertRouter(async (watchdog, paged) => {
    const { stale } = await watchdog.pageIfKillSwitchStale(tmp, {
      conditionKey: 'on-monitor-kill-switch-stale', label: 'test switch', clearHint: `rm ${tmp}`,
    });
    assert.equal(stale, false);
    assert.equal(paged.length, 0);
  });
});
