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
  TERMINAL_RUNTIME_MISSING: 'terminal-runtime-missing', // cmux never attached a terminal to this workspace — the command CANNOT run here (task #1904)
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
  [STATES.TERMINAL_RUNTIME_MISSING]: 'cmux created the workspace but never attached a terminal to it, so the typed command can never run there (cmux is at its terminal-runtime ceiling — close finished tabs or restart cmux)',
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
 * @param {boolean} [s.surfaceConfirmedMissing] cmux's own read-screen says this
 *                                  workspace has NO terminal surface (task #1904).
 *                                  Confirmed-missing only — an ordinary read
 *                                  error or a surface with nothing painted yet
 *                                  must arrive here as false.
 * @param {boolean} [s.atTerminalCapacity] the pre-create probe found cmux at its
 *                                  observed terminal-runtime ceiling, so no new
 *                                  workspace can get a terminal until one frees.
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
  surfaceConfirmedMissing = false,
  atTerminalCapacity = false,
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

  // 3b. cmux never attached a TERMINAL to this workspace, and the pre-create
  //     probe already found the app at its terminal-runtime ceiling. Task
  //     #1904, root-caused live 2026-08-26: past that cap cmux still creates
  //     the workspace and still accepts the --command, but the surface gets
  //     ghostty=nil / runtime=0 and the command can never run there. Nothing
  //     inside cmux fixes it — set-app-focus, open -a, simulate-app-active,
  //     refresh-surfaces, select-workspace, new-surface, send and a fresh
  //     WINDOW were all tested against a doomed workspace and did nothing.
  //     Only a runtime freeing (a tab closing) does.
  //
  //     So this is 'fail', never 'retry': the cap is app-wide, so a second
  //     new-workspace is equally doomed — retrying just doubles the wasted
  //     tabs, which is what turned a 31% dead rate into a 58% one.
  //
  //     BOTH signals are required. surfaceConfirmedMissing alone is not
  //     enough: measured runtime-attach lag on healthy launches was 0.1s x7
  //     but also 35.5s and 39.9s, so a workspace can legitimately be
  //     surface-less for half a minute. Acting on one signal here would be
  //     the short-timeout-then-retry mistake this file's own header opens
  //     with (#705, three identical crowned sessions in half an hour).
  if (surfaceConfirmedMissing && atTerminalCapacity) {
    return { action: 'fail', state: STATES.TERMINAL_RUNTIME_MISSING, reason: REASONS[STATES.TERMINAL_RUNTIME_MISSING] };
  }

  // 4. No wrapper has ever been seen. Inside the grace window the keystrokes
  //    may still be landing (cmux types into a pane that is itself still
  //    booting), so waiting costs nothing and a retry costs a duplicate.
  if (elapsed < injectionGraceSec) return { action: 'wait', state: STATES.AWAITING_INJECTION, reason: null };

  // 5. Grace expired with nothing ever running. The surface signal only
  //    changes the DIAGNOSIS here, never the retry policy: this is the
  //    uncorroborated case (capacity said we had room, or said nothing at
  //    all), so "no terminal" might be this one workspace's problem rather
  //    than the app's, and a fresh attempt may well work. Dropping the retry
  //    on one signal would be a behavior regression smuggled in under a
  //    capacity fix (ship-check catch) — `terminal()` keeps the exact
  //    attempt budget INJECTION_NEVER_RAN has always had.
  //
  //    The better label still earns its keep: it is what the caller records
  //    as a ceiling OBSERVATION, and two such observations are what arm the
  //    pre-create gate. Branch 3b above is the corroborated case, and it is
  //    the only one that skips the retry.
  return terminal(surfaceConfirmedMissing ? STATES.TERMINAL_RUNTIME_MISSING : STATES.INJECTION_NEVER_RAN,
    attempt, maxAttempts);
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
