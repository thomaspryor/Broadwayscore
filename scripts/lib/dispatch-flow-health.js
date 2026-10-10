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
 *
 * 2026-09-21 — the THIRD blindness, and the one that motivates measuring what
 * the watchdog DOES rather than proxies for it. From 2026-09-16T18:56Z to
 * 2026-09-19T23:19Z (76.4h) the watchdog made ZERO watchdog-redispatch claims
 * while health() logged "healthy" every 15 min. Every existing path was blind
 * at once: (1) `launch` rows kept flowing from retries/re-launches of EXISTING
 * jobs — 23 of the 64 45-min windows had launches>0 — so the zero-launch
 * precondition never held; (2) eligibleQueueDepth was -1 throughout, because
 * the caller only supplied it when `holds` was empty and a cmux-only hold was
 * active (BRO-3404 made those non-blocking for the headless lane; this check
 * never learned that) — and the launchd health process never loaded the
 * Linear board at all, so its depth was structurally 0 regardless (see
 * health() in dispatch-watchdog.js); (3) liveAutoWorkspaces counts cmux tabs,
 * which detached headless jobs never drop below 3.
 *
 * claimsLastWindow is the first term that reads the watchdog's OWN output: a
 * claim is the sweep deciding to take on new work. Zero of them for
 * CLAIM_WINDOW_MS while dispatchableDepth — core.stallDetectionDepth(plan), the
 * work the sweep WOULD claim this instant with every hold/budget/lane rule
 * already applied — is > 0 is a stall by definition, whatever launches or
 * tabs say. Deliberately NOT gated on dispatchPaused: pausedByPolicy includes
 * the cmux auto-tab ceiling, under which the headless lane keeps claiming
 * (BRO-3404), while a depth drawn from toDispatch is already 0 under every
 * genuine policy pause (kill switch, day/hour budget, concurrency cap) since
 * budget is 0 there. Gating on it would only silence the check in the one
 * case it must fire.
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
//
// BRO-3878: eligibleQueueDepth is plan.p01Queue.length, which used to include
// the frozen Notion mirror's ghost cards (measured ~61 pre-fix vs ~16 true
// Linear backlog) and no longer does. A genuinely-dead launcher with a
// smaller live backlog now needs the true count to exceed 20 to trip this
// path at all — worth re-measuring if this path stops firing in practice,
// but not changed here since the right bar for "true, tooling-corrected
// backlog is deep enough to prove dead" needs its own measurement.
const STALL_QUEUE_DEPTH_THRESHOLD = 20;

// 2026-09-21: lookback for watchdog-redispatch CLAIMS (the sweep taking on new
// work), the term that finally reads the watchdog's own output instead of a
// proxy. Six hours is measured, not chosen, against the real ledger:
//   - a 45-min claims window false-alarms: 11 of 32 windows on 2026-09-16 (a
//     known-good day, 183 claims) had zero claims AND free concurrency;
//   - the longest zero-claim gap on that good day was 3.1h, so 6h never
//     alarms there (0 of 96 15-min samples);
//   - 6h catches all three real incidents on record: the 76.4h stall of
//     16-19 Sep (280 of 284 samples, the first 4 being the ramp-in), the
//     16.2h halt on 15 Sep (the cmux-hold bug BRO-3404 fixed) and the 14.4h
//     gap on 20 Sep (the dark-then-mirror period in BRO-3896).
// Not derived from PACING_HOURS (8): pacing is a spend policy, detection is
// not, and coupling them would move this bar whenever the owner retunes spend.
const CLAIM_WINDOW_MS = 6 * 60 * 60 * 1000;

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
function isDispatchFlowDead({ liveAutoWorkspaces, launchesLast45m, eligibleQueueDepth = -1, dispatchPaused = false, claimsLastWindow = -1, dispatchableDepth = -1 }) {
  // Claims path (2026-09-21, see header): the sweep has taken on NO new work
  // for CLAIM_WINDOW_MS while there is work it would take right now. This is
  // evaluated FIRST and independently of the launch/tab terms below, because
  // those are exactly the terms that stayed green through the 76.4h stall.
  // -1 = caller could not count claims (unreadable ledger) -> cannot prove
  // dead, same fail-safe as launchesLast45m. Not gated on dispatchPaused —
  // see the header for why (toDispatch-derived depth is already 0 under every
  // genuine policy pause; the one pause it would add, the cmux tab ceiling,
  // is the one the headless lane keeps claiming through).
  // dispatchableDepth is a SEPARATE input from eligibleQueueDepth (ship-check,
  // 2026-09-22): it is toDispatch-derived and therefore capped at the per-sweep
  // budget, so feeding it to the legacy deep-queue path below would make that
  // path's > STALL_QUEUE_DEPTH_THRESHOLD test unreachable.
  if (claimsLastWindow === 0 && dispatchableDepth > 0) return true;
  // liveAutoWorkspaces null = cmux unobservable (ship-check 2026-09-22): the
  // tab and launch paths below cannot be proven, so they must not fire —
  // `null < MIN_LIVE_AUTO_WORKSPACES` is true in JS and would page on every
  // cmux hiccup. The claims path above does not need cmux and already ran.
  if (liveAutoWorkspaces === null || liveAutoWorkspaces === undefined) return false;
  if (launchesLast45m === -1) return false;
  if (launchesLast45m !== 0) return false;
  if (dispatchPaused) return false;
  if (liveAutoWorkspaces < MIN_LIVE_AUTO_WORKSPACES) return true;
  return eligibleQueueDepth !== -1 && eligibleQueueDepth > STALL_QUEUE_DEPTH_THRESHOLD;
}

module.exports = {
  isDispatchFlowDead, MIN_LIVE_AUTO_WORKSPACES, FLOW_WINDOW_MS, STALL_QUEUE_DEPTH_THRESHOLD, CLAIM_WINDOW_MS,
};
