import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isCrownLaunchTitle, shouldLaunchNewCrown } = require('./crown-fanout-guard.js');

// Exact fleet snapshot from BRO-2953 (2026-09-07, ~19:55 local), with the
// 👑 glyph cmux always prepends to owner-loop titles (dropped in the issue's
// plain-text transcript but present on every real tab — see
// dispatch-watchdog-core.js's WATCHDOG_TAB_PREFIX and prune-closeable.js's
// CROWN_TAB_RE).
const FLEET_SNAPSHOT = [
  { ref: 'workspace:11', title: '👑 OWNER — Crown v43 S0: main RED, BRO-2917 merge identity key' },
  { ref: 'workspace:117', title: '👑 OWNER — Crown v45 (BRO-343 backlog triage + dispatch loop)' },
  { ref: 'workspace:115', title: '👑 OWNER — land BRO-2841 follow-up + drain backlog' },
  { ref: 'workspace:120', title: '👑 OWNER-crown v48 — BRO-343 backlog triage + dispatch' },
  { ref: 'workspace:108', title: '👑 OWNER watchdog — 5 in flight, 18 need you, 200 P0/P1 queued' },
];

test('isCrownLaunchTitle: matches an owner-loop title naming Crown or BRO-343', () => {
  assert.equal(isCrownLaunchTitle('👑 OWNER — Crown v45 (BRO-343 backlog triage + dispatch loop)'), true);
  assert.equal(isCrownLaunchTitle('👑 OWNER — Crown v43 S0: main RED, BRO-2917 merge identity key'), true);
  assert.equal(isCrownLaunchTitle('👑 OWNER-crown v48 — BRO-343 backlog triage + dispatch'), true);
});

test('isCrownLaunchTitle: never matches the watchdog tab (same glyph prefix, different role)', () => {
  assert.equal(isCrownLaunchTitle('👑 OWNER watchdog — 5 in flight, 18 need you, 200 P0/P1 queued'), false);
});

test('isCrownLaunchTitle: never matches an ordinary auto-dispatch title', () => {
  assert.equal(isCrownLaunchTitle('🤖⚡ Data·BRO-2953 P1: no guard prevents multiple concurrent'), false);
  assert.equal(isCrownLaunchTitle(''), false);
  assert.equal(isCrownLaunchTitle(undefined), false);
});

test('shouldLaunchNewCrown: refuses a new crown when one is already live (5-crown fleet snapshot)', () => {
  const decision = shouldLaunchNewCrown(FLEET_SNAPSHOT, '👑 OWNER — Crown v49 successor (BRO-343 backlog triage + dispatch loop)');
  assert.equal(decision.allow, false);
  assert.ok(decision.existing);
  assert.match(decision.reason, /already running/);
});

test('shouldLaunchNewCrown: allows the launch when no crown-titled workspace exists', () => {
  const decision = shouldLaunchNewCrown([], '👑 OWNER — Crown v1 (BRO-343 backlog triage + dispatch loop)');
  assert.equal(decision.allow, true);
});

test('shouldLaunchNewCrown: allows when the only matches are non-crown-titled or a different role (watchdog)', () => {
  const workspaces = [
    { ref: 'workspace:108', title: '👑 OWNER watchdog — 5 in flight, 18 need you, 200 P0/P1 queued' },
    { ref: 'workspace:115', title: '👑 OWNER — land BRO-2841 follow-up + drain backlog' }, // owner-loop but names neither Crown nor BRO-343
    { ref: 'workspace:5', title: '🤖 Data·BRO-2921 fix something unrelated' },
  ];
  const decision = shouldLaunchNewCrown(workspaces, '👑 OWNER — Crown v1 (BRO-343 backlog triage + dispatch loop)');
  assert.equal(decision.allow, true);
});

test('shouldLaunchNewCrown: is a no-op for a launch that is not itself a crown-titled launch', () => {
  // Even with 5 live crowns already running, an ordinary auto-dispatch launch
  // (or the watchdog tab itself) must never be blocked by this guard.
  const decision = shouldLaunchNewCrown(FLEET_SNAPSHOT, '🤖 Data·BRO-1234 some other card');
  assert.equal(decision.allow, true);
});

test('shouldLaunchNewCrown: an explicitly-closed crown (absent from the workspace list) never blocks', () => {
  // cmux list-workspaces only ever lists open tabs — a closed workspace is
  // simply not in the array, which this predicate treats identically to "no
  // crown running."
  const decision = shouldLaunchNewCrown([], '👑 OWNER — Crown v50 (BRO-343 backlog triage + dispatch loop)');
  assert.equal(decision.allow, true);
});
