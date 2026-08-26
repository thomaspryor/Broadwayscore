import test from 'node:test';
import assert from 'node:assert/strict';
import { isDispatchFlowDead, MIN_LIVE_AUTO_WORKSPACES, FLOW_WINDOW_MS } from './dispatch-flow-health.js';

test('dead: below min live workspaces AND zero launches -> true', () => {
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 1, launchesLast45m: 0 }), true);
});

test('healthy: live workspaces at/above min -> false even with zero launches', () => {
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0 }), false);
});

test('healthy: any recent launch -> false even with few live workspaces', () => {
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 1, launchesLast45m: 5 }), false);
});

test('unreadable ledger (-1) -> false even when live workspaces below min (cannot prove dead)', () => {
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 0, launchesLast45m: -1 }), false);
});

test('exports the window constant used by the ledger scan', () => {
  assert.equal(FLOW_WINDOW_MS, 45 * 60 * 1000);
});
