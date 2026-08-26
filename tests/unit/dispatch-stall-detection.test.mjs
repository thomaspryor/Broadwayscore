// BRO-409 — dispatch loop stopped launching for 7.5h (2026-08-17) with 207
// eligible P0/P1 cards queued. The existing backstop's intervene condition
// (live auto-dispatch tabs < 3 AND zero ledger launches in 45m) never fired
// because live tabs sat pinned at exactly 3 the entire time — a stalled
// launcher holding exactly the minimum tab count is invisible to a check
// that only fires BELOW the minimum. This reproduces that incident shape
// against the real decision function (CLAUDE.md rule 15 — never copy guard
// logic into a test) and pins the new eligible-queue-depth term that closes
// the gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isDispatchFlowDead,
  MIN_LIVE_AUTO_WORKSPACES,
  STALL_QUEUE_DEPTH_THRESHOLD,
} = require('../../scripts/lib/dispatch-flow-health.js');

test('BRO-409 incident shape: live tabs at min, zero launches, deep eligible queue -> dead', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0, eligibleQueueDepth: 207 }),
    true,
  );
});

test('queue depth at the threshold does not trip', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0, eligibleQueueDepth: STALL_QUEUE_DEPTH_THRESHOLD }),
    false,
  );
});

test('queue depth just above the threshold trips', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0, eligibleQueueDepth: STALL_QUEUE_DEPTH_THRESHOLD + 1 }),
    true,
  );
});

test('any recent launch prevents the queue-depth path from tripping, even with a huge queue', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 1, eligibleQueueDepth: 500 }),
    false,
  );
});

test('unknown queue depth (-1 sentinel) never trips the new path on its own', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0, eligibleQueueDepth: -1 }),
    false,
  );
});

test('omitting eligibleQueueDepth defaults to the -1 sentinel (backward compatible)', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0 }),
    false,
  );
});

test('pre-existing tab-count path still fires independent of queue depth', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: 1, launchesLast45m: 0, eligibleQueueDepth: 0 }),
    true,
  );
});

test('unreadable ledger sentinel still wins over a deep queue and a low tab count', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: 0, launchesLast45m: -1, eligibleQueueDepth: 999 }),
    false,
  );
});
