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
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const core = require('../lib/dispatch-watchdog-core.js');

const NOW = Date.parse('2026-08-18T12:00:00Z');
const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// notion-action-poll.js calls main() unconditionally at load (no
// require.main === module guard) — requiring it here would trigger a real
// Notion poll. A source-text assertion is the same trade-off the file's own
// notion-action-poll.test.mjs already makes for its review-texts write guard;
// it catches the wiring itself being silently deleted, which the function-
// level tests below can't (ship-check finding, task #1720).
test('notion-action-poll.js wires the escalation-off file through pageIfKillSwitchStale', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'notion-action-poll.js'), 'utf8');
  assert.match(src, /require\(['"]\.\/dispatch-watchdog\.js['"]\)/, 'must import pageIfKillSwitchStale from dispatch-watchdog.js');
  assert.match(src, /pageIfKillSwitchStale\(\s*escalationOffFile/, 'must call pageIfKillSwitchStale with the escalation-off file path');
  assert.match(src, /conditionKey:\s*['"]escalation-kill-switch-stale['"]/, 'must use a conditionKey distinct from watchdog-kill-switch-stale');
});

// Codex adversarial review (task #1720) caught two regressions in the first
// cut: the check ran after acquireLock()/NOTION_API_KEY (so a Fix pipeline
// holding poll.lock for hours, or a broken auth env, silently blinded the
// one mechanism meant to catch the switch going stale), and it wasn't
// DRY_RUN-guarded (so the documented "safe ... preview" flag could write to
// the real alert ledger). Source-text-locks both fixes so they can't
// regress silently the way the original gap did.
test('the staleness check runs before acquireLock() and the NOTION_API_KEY gate', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'notion-action-poll.js'), 'utf8');
  const stalenessIdx = src.indexOf('pageIfKillSwitchStale(');
  // indexOf('acquireLock()') would match the function DEFINITION (much
  // earlier in the file) rather than its call site in main() — anchor on
  // the actual call, `!DRY_RUN && !acquireLock()`.
  const lockIdx = src.indexOf('!acquireLock()');
  const apiKeyIdx = src.indexOf('NOTION_API_KEY not set');
  assert.ok(stalenessIdx > -1 && lockIdx > -1 && apiKeyIdx > -1, 'expected all three markers to be present');
  assert.ok(stalenessIdx < lockIdx, 'staleness check must run before acquireLock() — a long-held lock must not blind the alarm');
  assert.ok(stalenessIdx < apiKeyIdx, 'staleness check must run before the NOTION_API_KEY gate — a broken auth env must not blind the alarm');
});

test('the staleness check is skipped on --dry-run (documented as a safe preview)', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'notion-action-poll.js'), 'utf8');
  const guardIdx = src.indexOf('if (!DRY_RUN) {');
  const stalenessIdx = src.indexOf('pageIfKillSwitchStale(');
  assert.ok(guardIdx > -1 && guardIdx < stalenessIdx, 'pageIfKillSwitchStale call must be inside an `if (!DRY_RUN)` block');
});

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
