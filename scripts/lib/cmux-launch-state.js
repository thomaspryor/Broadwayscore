/**
 * cmux-launch-state — the pure wait/retry decision for a cmux launch.
 *
 * Card #705 (2026-07-31, reproduced live 00:06-00:35 ET): cmux command
 * injection is NOT dead. Under load (30+ workspaces, a dozen live claudes) the
 * command cmux TYPES into the new pane can take 4-5 MINUTES to run and register
 * a claude_code tag. launchCmuxSession verified for 90s, called the launch
 * dead, CLOSED the workspace and launched again — while attempt 1 was still
 * mid-boot. All three "failed" launches that night came alive minutes later:
 * three identical crowned sessions on the same mandate, two had to be
 * SIGTERM'd. Short-timeout-then-retry is the duplicate factory, and it is the
 * 5th incident in the same family (#548, #559, #564, #567).
 *
 * The fix is to stop treating "no claude yet" as one state. The bash wrapper
 * launchCmuxSession writes (bsc-cmd-<seedKey>-<nonce>.sh) is the foreground
 * parent of the real claude process for the whole session, so its presence in
 * the OS process table separates the two cases that a single timeout conflates:
 *
 *   wrapper ALIVE, no claude tag  → the typed command RAN; claude is booting.
 *                                   Healthy-but-slow. Keep waiting. Retrying
 *                                   here is precisely what produced duplicates.
 *   wrapper never appeared        → the keystrokes were swallowed / mangled and
 *                                   nothing ever ran. Genuinely dead. Retry.
 *
 * Kept as a pure function (CLAUDE.md §15) so the decision is testable without
 * cmux, a Mac, or a 6-minute wall clock: launchCmuxSession does the probing,
 * this decides.
 */

// Seconds to wait for the wrapper process to APPEAR before concluding the
// typed command never ran. Covers cmux's own type-into-pane latency plus shell
// init (zsh + direnv) on a loaded host. Callers override.
const DEFAULT_INJECTION_GRACE_SEC = 90;

// Hard ceiling on the healthy-but-slow wait, from the wrapper first being seen.
// The 2026-07-31 reproduction measured 4-5 minutes to registration under load;
// 6 minutes leaves headroom without hanging a dispatch indefinitely.
const DEFAULT_SLOW_BOOT_CAP_SEC = 360;

const STATES = Object.freeze({
  REGISTERED: 'registered',                 // claude is live — launch verified
  AWAITING_INJECTION: 'awaiting-injection', // no wrapper yet, still inside the grace window
  LAUNCHING_SLOW: 'launching-slow',         // wrapper alive, claude not registered yet
  INJECTION_NEVER_RAN: 'injection-never-ran', // grace expired, wrapper never appeared
  WRAPPER_EXITED: 'wrapper-exited',         // wrapper ran and died without claude registering
  SLOW_BOOT_TIMEOUT: 'slow-boot-timeout',   // wrapper still alive at the cap — alive, just not verifiable yet
  WRAPPER_GONE_TAG_ALIVE: 'wrapper-gone-tag-alive', // wrapper not in ps, but cmux still reports a live claude
  SURFACE_NOT_FOUND: 'surface-not-found',   // wrapper+tag both said REGISTERED, but read-screen confirmed no terminal surface exists (card #1829)
});

// Human-readable reason per terminal state, for the launch result and logs.
// Callers (and the owner reading a digest) must be able to tell "cmux never
// ran my command" from "claude is still booting" — reporting both as "cmux is
// dead" is what produced the daily "cmux is broken" claims.
const REASONS = Object.freeze({
  [STATES.INJECTION_NEVER_RAN]: 'command injection never ran (no wrapper process appeared)',
  [STATES.WRAPPER_EXITED]: 'launch wrapper exited without claude registering',
  [STATES.SLOW_BOOT_TIMEOUT]: 'claude still had not registered at the slow-boot cap (wrapper process still alive — may yet come up)',
  [STATES.WRAPPER_GONE_TAG_ALIVE]: 'launch wrapper is gone from the process table but cmux still reports a live claude in the workspace — ambiguous, left alone',
  [STATES.SURFACE_NOT_FOUND]: 'wrapper process and cmux tag both registered, but read-screen confirms the terminal surface was never rendered — not a live session',
});

/**
 * Decide what a launch-verification poll should do next.
 *
 * @param {object} s
 * @param {boolean} s.claudeRegistered  a live claude is verified for this launch
 * @param {boolean} s.wrapperAlive      this launch's bash wrapper is in the OS process table RIGHT NOW
 * @param {boolean} s.wrapperEverSeen   it was seen alive at any earlier poll of this attempt
 * @param {boolean} s.tagAlive          cmux's own registry reports a live claude in this workspace
 * @param {number}  s.elapsedSec        seconds since new-workspace returned
 * @param {number}  [s.bootElapsedSec]  seconds since the wrapper was FIRST seen (defaults to
 *                                      elapsedSec). The slow-boot cap is a boot budget, so it
 *                                      must not be eaten by however long the injection took to
 *                                      land — a wrapper that appears at 89s of a 90s grace
 *                                      otherwise got 271s of a nominal 360s (Codex ship-check).
 * @param {number}  [s.attempt]         1-based attempt number
 * @param {number}  [s.maxAttempts]     attempts allowed in total
 * @param {number}  [s.injectionGraceSec]
 * @param {number}  [s.slowBootCapSec]
 * @returns {{action: 'ok'|'wait'|'retry'|'fail', state: string, reason: string|null}}
 */
function decideLaunchWait({
  claudeRegistered = false,
  wrapperAlive = false,
  wrapperEverSeen = false,
  tagAlive = false,
  elapsedSec = 0,
  bootElapsedSec = null,
  attempt = 1,
  maxAttempts = 2,
  injectionGraceSec = DEFAULT_INJECTION_GRACE_SEC,
  slowBootCapSec = DEFAULT_SLOW_BOOT_CAP_SEC,
} = {}) {
  const elapsed = Number.isFinite(elapsedSec) ? Math.max(0, elapsedSec) : 0;
  const booting = Number.isFinite(bootElapsedSec) ? Math.max(0, bootElapsedSec) : elapsed;

  // 1. Verified — nothing else matters.
  if (claudeRegistered) return { action: 'ok', state: STATES.REGISTERED, reason: null };

  // 2. The command RAN and its process is alive: healthy-but-slow. Never retry
  //    from here — a second new-workspace while attempt 1 is mid-boot is the
  //    duplicate factory this card exists to close. Wait to the cap, then
  //    report a DISTINCT state so the caller leaves the workspace alone.
  if (wrapperAlive) {
    return booting < slowBootCapSec
      ? { action: 'wait', state: STATES.LAUNCHING_SLOW, reason: null }
      : { action: 'fail', state: STATES.SLOW_BOOT_TIMEOUT, reason: REASONS[STATES.SLOW_BOOT_TIMEOUT] };
  }

  // 2b. Wrapper gone, but cmux still reports a live claude in the workspace.
  //     The two signals disagree, and the failure mode of each is asymmetric:
  //     believing "dead" closes and relaunches over what may be a real
  //     session (the #705 duplicate), while believing "alive" only costs an
  //     unverified report. Never retry into ambiguity — hand the caller a
  //     not-dead failure and leave the workspace alone. (Reachable when the
  //     wrapper is SIGKILLed and orphans its claude child, or when a ps
  //     sample is unreliable.)
  if (tagAlive) return { action: 'fail', state: STATES.WRAPPER_GONE_TAG_ALIVE, reason: REASONS[STATES.WRAPPER_GONE_TAG_ALIVE] };

  // 3. Wrapper ran and is now GONE with no claude anywhere: the command died
  //    (bad settings path, crashed shell, killed pane). Genuinely dead — the
  //    one non-injection case where a fresh attempt is the right move.
  if (wrapperEverSeen) return terminal(STATES.WRAPPER_EXITED, attempt, maxAttempts);

  // 4. No wrapper has ever been seen. Inside the grace window the keystrokes
  //    may still be landing (cmux types into a pane that is itself still
  //    booting), so waiting costs nothing and a retry costs a duplicate.
  if (elapsed < injectionGraceSec) return { action: 'wait', state: STATES.AWAITING_INJECTION, reason: null };

  // 5. Grace expired with nothing ever running: the injection was swallowed.
  return terminal(STATES.INJECTION_NEVER_RAN, attempt, maxAttempts);
}

function terminal(state, attempt, maxAttempts) {
  return attempt < maxAttempts
    ? { action: 'retry', state, reason: REASONS[state] }
    : { action: 'fail', state, reason: REASONS[state] };
}

// True when verification failed but something may still be alive in the
// workspace — the caller must NOT close it, journal a death, or dispatch a
// replacement. Covers both "wrapper still running" and "signals disagree".
function isSlowBootFailure(state) {
  return state === STATES.SLOW_BOOT_TIMEOUT || state === STATES.WRAPPER_GONE_TAG_ALIVE;
}

module.exports = {
  decideLaunchWait, isSlowBootFailure,
  STATES, REASONS,
  DEFAULT_INJECTION_GRACE_SEC, DEFAULT_SLOW_BOOT_CAP_SEC,
};
