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
 *
 * BRO-409: the tab-count term above went blind for 7.5h on 2026-08-17 — the
 * launcher stalled with 207 eligible P0/P1 cards sitting in the queue while
 * live auto-dispatch tabs sat pinned at exactly MIN_LIVE_AUTO_WORKSPACES (3)
 * the whole time, so `liveAutoWorkspaces < MIN_LIVE_AUTO_WORKSPACES` never
 * evaluated true. A stalled launcher holding exactly 3 tabs open is
 * invisible to a check that only fires BELOW 3. eligibleQueueDepth adds a
 * second, independent path to "dead": zero launches in the window is
 * unconditionally alarming once the backlog is deep enough that "nothing to
 * dispatch" cannot explain the silence, regardless of how many tabs happen
 * to be open. The caller (dispatch-watchdog.js) is responsible for only
 * supplying a real eligibleQueueDepth when dispatch is actually enabled —
 * see its dispatchEnabled() gate — so a deliberate dispatch pause (which
 * legitimately produces zero launches and a growing queue) never pages.
 *
 * BRO-2462: that gate only ever covered the NEW eligibleQueueDepth path. The
 * original tab-count term (liveAutoWorkspaces < MIN_LIVE_AUTO_WORKSPACES)
 * predates BRO-409 and paged unconditionally — including during the exact
 * same deliberate-pause / day-budget-spent hold BRO-409 carved an exception
 * for on the other path. dispatchPaused now gates BOTH paths: true only for
 * a genuine policy pause (kill-switch, day budget, concurrency cap, tab
 * ceiling) — NOT for a detected failure (launcher outage, failure-rate leak,
 * claim outage), which must still page through the tab-count path even when
 * it also appears in the caller's `holds` list. See dispatch-watchdog-core.js's
 * `pausedByPolicy` for the split.
 */
'use strict';

// Below this many live auto-dispatch workspaces AND zero recent launches is
// the confirmed-dead signature; matches the retired shell backstop's bar.
const MIN_LIVE_AUTO_WORKSPACES = 3;

// Recent-launch lookback window (matches the retired shell backstop).
const FLOW_WINDOW_MS = 45 * 60 * 1000;

// BRO-409: an eligible P0/P1 queue deeper than this, combined with zero
// launches in the window, cannot be explained by "the backlog is drained" —
// it trips the alarm independent of live-tab count.
const STALL_QUEUE_DEPTH_THRESHOLD = 20;

// launchesLast45m === -1 means the ledger was unreadable — "cannot prove
// dead" must win over "looks dead" (fail-safe: an I/O hiccup must never
// page as a real outage). eligibleQueueDepth === -1 (default) means the
// caller could not compute the queue depth, OR dispatch is deliberately
// paused (see this file's header) — same fail-safe: an unknown/not-trusted
// queue depth must never itself trip the alarm, it only ever widens
// detection when the caller supplies a real, dispatch-enabled count.
// dispatchPaused (BRO-2462) short-circuits BOTH trip paths — the caller
// must only set it true for a genuine policy pause, never for a detected
// failure (that must still page through the tab-count path below).
function isDispatchFlowDead({ liveAutoWorkspaces, launchesLast45m, eligibleQueueDepth = -1, dispatchPaused = false }) {
  if (launchesLast45m === -1) return false;
  if (launchesLast45m !== 0) return false;
  if (dispatchPaused) return false;
  if (liveAutoWorkspaces < MIN_LIVE_AUTO_WORKSPACES) return true;
  return eligibleQueueDepth !== -1 && eligibleQueueDepth > STALL_QUEUE_DEPTH_THRESHOLD;
}

module.exports = {
  isDispatchFlowDead, MIN_LIVE_AUTO_WORKSPACES, FLOW_WINDOW_MS, STALL_QUEUE_DEPTH_THRESHOLD,
};
