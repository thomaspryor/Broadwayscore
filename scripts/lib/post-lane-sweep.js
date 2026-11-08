'use strict';
/**
 * BRO-7160: the post-lane review sweep. The Broadway fast lane starts at embargo -30 min and runs 270 min, so its lease
 * releases at about embargo +4h. Nothing collected reviews after that: critics who publish at +4h to +12h waited for
 * the next scheduled poller tick (GitHub crons fire 1-6h late). The press-night clock now plans three sweep slots per
 * Broadway night (press-night-clock.js KINDS sw1/sw2/sw3 at embargo +4h15, +5h15, +6h15) and a verify slot (swv, +7h30).
 * Each slot runs scripts/post-lane-sweep.js, which dispatches one targeted opening-night-poller run
 * (fast_path=true, force_serp=true) for the show. Pure decisions live here; the CLI does the I/O.
 *
 * Rules (decideSweep):
 *   - kill switch (repo variable POST_LANE_SWEEP_DISABLED=true) -> skip
 *   - a live lane lease on the show -> skip (the lane is still collecting; a later slot runs after it releases)
 *   - lease state unreadable -> dispatch (fail toward collecting; a duplicate poller run is cheap and its concurrency
 *     group is per show)
 *   - a poller run for the show created at or after the slot time -> skip (already swept; any status)
 *   - otherwise dispatch
 * The verify slot (decideVerify) redispatches once when the newest poller run since the last sweep slot failed, was
 * cancelled, or never started. LANE_ONLY_MARKETS is deliberately not consulted: the sweep is useful whichever path ran
 * the night, and it never touches the lane's own state.
 */
const { liveLeaseFor } = require('./opening-night-lane/lane-only-markets');

const MIN = 60000;
/** Minutes after embargo. Kept in sync with press-night-clock.js KINDS (pinned by tests/unit/post-lane-sweep.test.mjs). */
const SWEEP_SLOTS = { sw1: 255, sw2: 315, sw3: 375 };
const VERIFY_SLOT = { swv: 450 };
const POLLER_WORKFLOW = 'opening-night-poller.yml';
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure']);

function isSweepKind(kind) { return Object.prototype.hasOwnProperty.call(SWEEP_SLOTS, kind) || Object.prototype.hasOwnProperty.call(VERIFY_SLOT, kind); }

/** Slot time (ms) for a kind, or NaN. */
function slotAtMs(embargoMs, kind) {
  const min = SWEEP_SLOTS[kind] != null ? SWEEP_SLOTS[kind] : VERIFY_SLOT[kind];
  return min == null ? NaN : embargoMs + min * MIN;
}

/** Every slot for a night as [{kind, atMs, atIso}] in time order. Pure. */
function planSlots(embargoMs) {
  return [...Object.keys(SWEEP_SLOTS), ...Object.keys(VERIFY_SLOT)]
    .map((kind) => ({ kind, atMs: slotAtMs(embargoMs, kind) }))
    .map((s) => ({ ...s, atIso: new Date(s.atMs).toISOString() }))
    .sort((a, b) => a.atMs - b.atMs);
}

/** The poller's run-name for a targeted run ("Opening Night Poller — <show>"). */
function isPollerRunFor(run, showId) {
  const t = String((run && run.displayTitle) || '');
  return t.startsWith('Opening Night Poller') && t.trim().endsWith(` ${showId}`);
}

/** Poller runs for the show created at or after sinceMs, newest first. Pure. */
function pollerRunsSince(runs, showId, sinceMs) {
  return (runs || [])
    .filter((r) => isPollerRunFor(r, showId) && Date.parse(r.createdAt) >= sinceMs)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * One sweep slot. Inputs: showId, kind (sw1|sw2|sw3), embargoMs, nowMs, leaseState (null = unreadable), runs
 * (poller runs, null = unreadable), disabled. Returns {action: 'dispatch'|'skip', reason}. Pure.
 */
function decideSweep({ showId, kind, embargoMs, nowMs, leaseState, runs, disabled }) {
  if (disabled) return { action: 'skip', reason: 'POST_LANE_SWEEP_DISABLED is set' };
  if (SWEEP_SLOTS[kind] == null) return { action: 'skip', reason: `not a sweep slot: ${kind}` };
  const atMs = slotAtMs(embargoMs, kind);
  const lease = leaseState ? liveLeaseFor(leaseState, showId, nowMs) : null;
  if (lease) return { action: 'skip', reason: `the lane still holds ${showId} (lease ${lease.holder} until ${lease.expiresAt}); a later slot sweeps after it releases` };
  if (Array.isArray(runs)) {
    const since = pollerRunsSince(runs, showId, atMs);
    if (since.length) return { action: 'skip', reason: `a poller run for ${showId} already started since ${new Date(atMs).toISOString()} (${since[0].status || 'unknown'})` };
  }
  return { action: 'dispatch', reason: leaseState ? 'no live lane lease' : 'lease state unreadable: sweeping anyway' };
}

/**
 * The verify slot: did the last sweep produce a finished, non-failed poller run? Redispatch once if not.
 * Returns {action: 'redispatch'|'ok'|'skip', reason}. runs null = unreadable -> skip (nothing to judge). Pure.
 */
function decideVerify({ showId, embargoMs, nowMs, leaseState, runs, disabled }) {
  if (disabled) return { action: 'skip', reason: 'POST_LANE_SWEEP_DISABLED is set' };
  if (!Array.isArray(runs)) return { action: 'skip', reason: 'poller runs unreadable' };
  const lease = leaseState ? liveLeaseFor(leaseState, showId, nowMs) : null;
  if (lease) return { action: 'skip', reason: `the lane still holds ${showId}` };
  const firstSweep = slotAtMs(embargoMs, 'sw1');
  const since = pollerRunsSince(runs, showId, firstSweep);
  if (!since.length) return { action: 'redispatch', reason: 'no poller run since the first sweep slot' };
  const latest = since[0];
  if (latest.status && latest.status !== 'completed') return { action: 'ok', reason: `latest poller run is ${latest.status}` };
  if (FAILED.has(latest.conclusion)) return { action: 'redispatch', reason: `latest poller run ended ${latest.conclusion}` };
  return { action: 'ok', reason: `latest poller run ended ${latest.conclusion || 'unknown'}` };
}

/** Claim key and stable holder on the lane fallback branch (one claim per show, night and slot). */
function claimId(showId, kind) { return `${showId}~pnw-sweep-${kind}`; }
function claimHolder(showId, night, kind) { return `sweep-${showId}-${night}-${kind}`; }

/**
 * The claim branch itself is broken (cannot read, commit or push): dispatch anyway, failing toward collecting like
 * auto-fallback.js does after CLAIM_FAILURES_BEFORE_DISPATCH. The run-title dedupe in decideSweep already ran, so the
 * cost is at most one extra poller run, absorbed by its per-show concurrency group. A contended or in-flight claim
 * means another runner is on it: never dispatch then. Pure.
 */
const BRANCH_BROKEN = /^not claimed \((state-unreadable|commit-failed|push-failed)\)$/;
function dispatchDespiteClaim(result) {
  return !!result && !result.sent && !result.spent && BRANCH_BROKEN.test(String(result.reason || ''));
}

function dispatchArgs(showId) {
  return ['workflow', 'run', POLLER_WORKFLOW, '-f', `show_id=${showId}`, '-f', 'fast_path=true', '-f', 'force_serp=true', '-f', 'collect_existing=true'];
}

module.exports = {
  SWEEP_SLOTS, VERIFY_SLOT, POLLER_WORKFLOW, isSweepKind, slotAtMs, planSlots, isPollerRunFor, pollerRunsSince,
  decideSweep, decideVerify, claimId, claimHolder, dispatchArgs, dispatchDespiteClaim,
};
