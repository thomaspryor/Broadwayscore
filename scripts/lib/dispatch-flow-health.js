/**
 * dispatch-flow-health — pure decision for the dispatch-watchdog blind spot
 * where the watchdog heartbeat is healthy but nothing is actually being
 * dispatched (task #1915, Notion 3c8637c5-416f-8195-a5e1-d940cb9d98e0).
 *
 * health() in dispatch-watchdog.js only ever checked heartbeat staleness —
 * the owner has been hand-running a shell backstop
 * (~/Documents/claude-outputs/dispatcher-backstop-check.sh) to cover this
 * gap: DEAD == too few live auto-dispatch workspaces AND zero ledger
 * launches in the recent window. This module is that same decision, ported
 * in and tested.
 */
'use strict';

// Below this many live auto-dispatch workspaces AND zero recent launches is
// the confirmed-dead signature; matches the retired shell backstop's bar.
const MIN_LIVE_AUTO_WORKSPACES = 3;

// Recent-launch lookback window (matches the retired shell backstop).
const FLOW_WINDOW_MS = 45 * 60 * 1000;

// launchesLast45m === -1 means the ledger was unreadable — "cannot prove
// dead" must win over "looks dead" (fail-safe: an I/O hiccup must never
// page as a real outage).
function isDispatchFlowDead({ liveAutoWorkspaces, launchesLast45m }) {
  if (launchesLast45m === -1) return false;
  return liveAutoWorkspaces < MIN_LIVE_AUTO_WORKSPACES && launchesLast45m === 0;
}

module.exports = { isDispatchFlowDead, MIN_LIVE_AUTO_WORKSPACES, FLOW_WINDOW_MS };
