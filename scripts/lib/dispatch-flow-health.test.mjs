import test from 'node:test';
import assert from 'node:assert/strict';
import { isDispatchFlowDead, MIN_LIVE_AUTO_WORKSPACES, FLOW_WINDOW_MS, CLAIM_WINDOW_MS } from './dispatch-flow-health.js';

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

// ── claims path (2026-09-21) ────────────────────────────────────────────────
// The 16-19 Sep incident shape: launches still flowing from retries, cmux tabs
// well above the minimum, a cmux-only hold active — every pre-existing term
// green — while the sweep claimed nothing for 76.4h with work available.

test('claims path: zero claims in the window with claimable work -> dead, even though launches and tabs look healthy', () => {
  assert.equal(isDispatchFlowDead({
    liveAutoWorkspaces: 12,      // detached headless jobs keep this high
    launchesLast45m: 4,          // retries/re-launches of EXISTING jobs
    dispatchableDepth: 7,       // core.stallDetectionDepth(plan): work the sweep would take now
    claimsLastWindow: 0,
  }), true);
});

test('claims path: a lull is not a stall — zero claims but nothing claimable -> false', () => {
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 12, launchesLast45m: 4, dispatchableDepth: 0, claimsLastWindow: 0 }), false);
});

test('claims path: unknown depth (-1) never trips it', () => {
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 12, launchesLast45m: 4, dispatchableDepth: -1, claimsLastWindow: 0 }), false);
});

test('claims path: unreadable claims (-1) never trips it — cannot prove dead', () => {
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 12, launchesLast45m: 4, dispatchableDepth: 7, claimsLastWindow: -1 }), false);
});

test('claims path: any claim in the window -> not dead on this path', () => {
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 12, launchesLast45m: 4, dispatchableDepth: 7, claimsLastWindow: 1 }), false);
});

test('claims path is NOT gated on dispatchPaused: the cmux tab ceiling pauses tabs, not the headless lane (BRO-3404)', () => {
  // pausedByPolicy includes the auto-tab ceiling, under which headless work
  // is still claimed. A toDispatch-derived depth is already 0 under every
  // genuine policy pause, so the only effect of gating here would be to
  // silence the one case that must fire.
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 12, launchesLast45m: 4, dispatchableDepth: 7, claimsLastWindow: 0, dispatchPaused: true }), true);
});

test('claims path default (omitted) leaves the four legacy paths exactly as before', () => {
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 1, launchesLast45m: 0 }), true);
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0 }), false);
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 1, launchesLast45m: 5 }), false);
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: 0, launchesLast45m: -1 }), false);
});

test('exports the claims window and it is the measured 6h, not derived from pacing', () => {
  assert.equal(CLAIM_WINDOW_MS, 6 * 60 * 60 * 1000);
});

test('cmux unobservable (liveAutoWorkspaces null): claims path still fires; tab/launch paths cannot', () => {
  // null < MIN_LIVE_AUTO_WORKSPACES is true in JS — must not page on a cmux hiccup.
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: null, launchesLast45m: 0 }), false);
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: null, launchesLast45m: 0, eligibleQueueDepth: 500 }), false);
  assert.equal(isDispatchFlowDead({ liveAutoWorkspaces: null, launchesLast45m: 3, claimsLastWindow: 0, dispatchableDepth: 4 }), true);
});
