/**
 * cmux-launch — shared "open a cmux workspace already running Claude Code"
 * primitive. Extracted from bsc-next.js launchCmux() (2026-07-24) so non-task
 * callers (opening-night monitor launcher) get the same verified launch
 * mechanics without fabricating a fake task object: seed/cmd wrapper files
 * (shell-init race, 2026-07-12), up to two launch attempts, a wrapper-process
 * -aware verification wait (a mangled command never starts claude and nothing
 * else would notice), and the Blue auto-dispatch tab color.
 *
 * Verification is a state machine, not a timeout (card #705, 2026-07-31): the
 * wait/retry decision lives in cmux-launch-state.js and turns on whether THIS
 * launch's bash wrapper is in the OS process table. Wrapper alive + no claude
 * means booting-under-load (measured 4-5 min on a 30-workspace host) and must
 * keep waiting; only a wrapper that never appeared, or appeared and died, is a
 * real death that earns a second attempt. The old fixed window retried into a
 * live boot and produced three identical crowned sessions in one night.
 *
 * bsc-next.js composes its task-derived title/seedKey and delegates here with
 * seedKey = task.id, so the seed-file path and typed command are
 * byte-identical to the pre-extraction behavior. The cmd-wrapper filename
 * carries an added per-call nonce (card #548, 2026-07-26) so the OS-process
 * liveness cross-check can't be satisfied by a stale leftover process from an
 * earlier dispatch attempt on the same task.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const cmuxws = require('./cmux-workspaces.js');
const { decideLaunchWait, isSlowBootFailure, STATES,
  DEFAULT_SLOW_BOOT_CAP_SEC } = require('./cmux-launch-state.js');
const { preflightAuth } = require('./claude-cli.js');
const { ensureAutoTitle } = require('./workspace-naming.js');

const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const CMUX_APP = '/Applications/cmux.app';

// Launch attempts per call. A second attempt is only ever reached when the
// first left NOTHING running (see cmux-launch-state.js) — relaunching over a
// live boot is what produced duplicate sessions.
const MAX_ATTEMPTS = 2;

// Seconds between verification probes. Each poll costs one `ps -e` (plus one
// cmux call only when the wrapper is up), so a 6-minute slow-boot wait is
// ~120 probes — cheap, and coarse enough not to spin.
const PROBE_INTERVAL_SEC = 3;

// Consecutive ps samples that must MISS the wrapper before it counts as gone.
// The probe fails closed on any ps error/timeout/truncation, and a single
// false miss would otherwise close and relaunch a live session.
const WRAPPER_MISS_STREAK = 2;

// Seconds without the wrapper EVER appearing before forcing cmux awake (see
// setAppFocus). A healthy injection produces the wrapper within ~2-3s even on
// a loaded host; 5s is late enough not to wake on every launch and early
// enough that the injection grace window still has its full meaning after.
const WAKE_AFTER_SEC = 5;

// ── Idle-gated PRE-wake (card #1199) ──────────────────────────────────────
// WAKE_AFTER_SEC's wake is REACTIVE: it fires only after the wrapper has
// already failed to appear, i.e. after the surface has already been deferred
// and the --command already not run. Measured over 399 real cmux launches
// (scripts/lib/dispatch-health.js, the aggregator this card added), the
// deaths cluster on launches into an IDLE app, and the correlation is the
// opposite of the "burst" theory the card originally proposed:
//
//   gap since previous cmux launch:  <5s 8%   5-30s 9%   30-120s 11%
//                                    2-10m 18%   >10m 22%
//   other launches in previous 60s:  solo 19%   1-2 others 7%
//   hour (ET):  10:00 0/26   11:00 0/12   19:00 1/38   vs   00:00 12/47,
//               21:00 7/13, 23:00 6/18
//   model-independent (sonnet 17%, opus 13%), and deaths come in runs of up
//   to 8 back-to-back — a persistent app state, not a per-launch coin flip.
//   Machine sleep is ruled out: `pmset -g log` shows no Entering Sleep on
//   2026-08-09/10, only powerd darkwake prediction assertions.
//
// So: assert the same socket-level flag BEFORE `new-workspace`, so the
// surface renders at creation instead of being deferred and then rescued.
//
// IDLE-GATED rather than unconditional (pre-implementation review, #1079
// gate). setAppFocus('active') is a persistent override that
// launchCmuxSession clears in a finally, and that clear is launch-scoped, not
// refcounted — a concurrent launcher's clear can re-defer another launch's
// still-unrendered surface (see REWAKE_INTERVAL_SEC below). Waking on EVERY
// launch would make `woke` true in busy concurrent batches, turning that rare
// collision into the common case — and precisely in the regime the data shows
// is currently SAFEST (7% dead with 1-2 concurrent siblings vs 19% solo).
// Gating on "no other launch in the last IDLE_GATE_SEC" keeps `woke`
// correlated with genuinely-idle conditions exactly as it is today (an idle
// launch has, by construction, no concurrent sibling), while covering the
// >2min-gap / solo / off-hours segment where nearly all the deaths are.
const IDLE_GATE_SEC = 120;

// Cross-PROCESS idleness signal: every bsc-next dispatch is its own node
// process, so in-memory state can't see a sibling launcher. An mtime marker
// in tmpdir is the smallest thing that works and needs no new schema. NOT the
// dispatch ledger: the ledger's launch row is written by the CALLER after
// this function returns, so it is always stale by exactly the window that
// matters here.
const LAST_LAUNCH_MARKER = path.join(os.tmpdir(), 'bsc-cmux-last-launch');

// Seconds since the last launch attempt on this host, or Infinity when the
// marker is missing (first launch after a reboot/tmp clear — treat as idle,
// which is what it is).
function cmuxIdleSec(markerPath = LAST_LAUNCH_MARKER, nowMs = Date.now()) {
  let idle;
  try { idle = (nowMs - fs.statSync(markerPath).mtimeMs) / 1000; } catch { return Infinity; }
  // Sub-millisecond negative jitter is normal, not a clock anomaly: Date.now()
  // has ms resolution while mtimeMs carries the filesystem's finer clock, so a
  // marker stamped microseconds ago reads as ~-0.0005s. Caught by this file's
  // own round-trip test. shouldPreWake treats a negative as "unknown → wake",
  // so leaving it unclamped would make a just-stamped marker wake anyway —
  // defeating the concurrency gate in exactly the window it exists to cover.
  // A genuinely large negative IS a clock step, and stays "unknown".
  if (idle < 0) return idle > -1 ? 0 : Infinity;
  return idle;
}

// Returns whether the stamp landed. A silent failure here is NOT harmless
// (ship-check finding): if the marker can never be written (full/read-only
// tmpdir, permissions), its mtime stops advancing, cmuxIdleSec() reports an
// ever-growing gap, and shouldPreWake starts returning true on EVERY launch —
// reproducing exactly the unconditional-wake amplification the idle gate
// exists to prevent, in the concurrent-batch regime the data shows is
// currently safest. Still non-fatal (a launch that might succeed must never
// be blocked by a scratch-file write), but it announces itself once per
// process instead of degrading in silence.
let markerWriteFailureLogged = false;
function noteLaunchAttempt(markerPath = LAST_LAUNCH_MARKER) {
  try {
    fs.writeFileSync(markerPath, new Date().toISOString());
    return true;
  } catch (e) {
    if (!markerWriteFailureLogged) {
      markerWriteFailureLogged = true;
      console.error(`[cmux-launch] WARN cannot stamp ${markerPath} (${e.message}) — the idle gate will now pre-wake on EVERY launch instead of only idle ones (card #1199). Non-fatal, but fix the tmpdir.`);
    }
    return false;
  }
}

// Pure decision (rule 15 — the test require()s this rather than re-deriving
// it). Anything that is not a real, in-range idle reading pre-wakes: a
// missing marker, a NaN, or a negative (marker stamped in the future by a
// clock step) are all "we don't know", and the cheap socket flag is the safe
// answer to not knowing. attempt >= 2 always pre-wakes — a retry only happens
// after an attempt left nothing running, which is itself evidence of the
// deferred-render state, and that population is already `woke` today.
function shouldPreWake({ idleSec, attempt = 1, idleGateSec = IDLE_GATE_SEC }) {
  if (attempt >= 2) return true;
  return !(typeof idleSec === 'number' && idleSec >= 0 && idleSec < idleGateSec);
}

// Seconds between wake re-fires while the wrapper still has not appeared.
// set-app-focus active is a persistent override, so one call normally
// suffices — but a CONCURRENT launcher that also woke clears the override
// when it finishes (the clear is launch-scoped, not refcounted), which would
// re-defer this launch's still-unrendered surface. Re-asserting is idempotent
// and costs one cmux round trip per interval.
const REWAKE_INTERVAL_SEC = 10;

// Pure — extracted (task #1438) so the exact --model/--dangerously-skip-
// permissions shape is behavior-tested directly instead of via a source-text
// regex against this file (the #1432/#1434 fragile-pattern class: a harmless
// reformat of this template would break a regex pinning it while the actual
// launched command stayed identical).
// --dangerously-skip-permissions: launched sessions must never permission-ping
// (user rule 2026-07-12); explicit permissions.deny rules still outrank bypass.
function buildLaunchCommand(model, settingsPath, seedFile) {
  const settingsArg = settingsPath ? ` --settings ${settingsPath}` : '';
  return `claude --model ${model}${settingsArg} --dangerously-skip-permissions "$(cat ${seedFile})"`;
}

function sleepSec(s) { spawnSync('sleep', [String(s)]); }

// Poll fn() every second until it returns truthy or timeoutSec elapses.
function pollUntil(fn, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    sleepSec(1);
  }
}

// Best-effort color-code (scope add, card #168): auto-dispatched workspaces
// go Blue so the owner can distinguish "safe to ignore" tabs from ones they
// opened themselves at a glance. Never blocks or fails the dispatch — a
// verified-running claude session matters more than its tab color.
function setAutoColor(ref) {
  try { spawnSync(CMUX, ['workspace-action', '--action', 'set-color', '--color', 'Blue', '--workspace', ref], { encoding: 'utf8', timeout: 3000 }); } catch { /* cosmetic only */ }
}

// Force cmux out of its deferred-render state (diagnosed live 2026-08-02):
// while the app is backgrounded, cmux does not create the terminal surface
// for a new workspace, so the --command it was handed never EXECUTES — task
// #828's typed command sat un-run for 77 minutes until the owner foregrounded
// the app, at which point every deferred tab booted at once. To the verifier
// below, that deferral is indistinguishable from a swallowed injection, and
// INJECTION_NEVER_RAN → retry is the duplicate factory: BOTH workspaces boot
// on the next foreground (live duplicate pair reproduced same day).
// `set-app-focus active` is a persistent override that makes deferred
// surfaces materialize and their commands run (validated live: a probe
// command deferred 20s+ under `set-app-focus inactive` started within
// seconds of this call; `simulate-app-active` alone did NOT wake it).
// The override must not outlive the launch — launchCmuxSession clears it in
// a finally, otherwise cmux would be blinded to the app's real focus state
// indefinitely.
function setAppFocus(state) {
  try { return spawnSync(CMUX, ['set-app-focus', state], { encoding: 'utf8', timeout: 3000 }).status === 0; } catch { return false; }
}

// OS-level companion to setAppFocus (card #900, 2026-08-03): `set-app-focus`
// is an IPC call INTO cmux's own socket handler asserting an internal flag —
// it never touches the real macOS window server. Six launches across five
// different tasks (897/855x2/857/902/901) died INJECTION_NEVER_RAN in the
// two hours after the 8/3 "cmux hangs" restart despite this flag firing on
// every one of them, then launches started succeeding again the moment
// someone was actually driving the app (this task's own launch, and a live
// diagnostic re-test, both succeeded instantly). The common factor isn't
// backgrounded-vs-foregrounded from cmux's own point of view — it's whether
// the OS ever actually activates cmux's window. `open -a` asks the OS
// itself to do that: for an app that is merely occluded, on another Space,
// or minimized (states set-app-focus cannot reach because it never leaves
// cmux's process), activation forces a real render pass. Best-effort and
// silent on failure — a missing/renamed app bundle must never block a
// launch that might still succeed on the socket-level flag alone.
function osActivateCmuxApp() {
  try { spawnSync('open', ['-a', CMUX_APP], { timeout: 3000 }); } catch { /* best-effort recovery only */ }
}

// Fail-CLOSED liveness for the late-adopt path. cmuxws.claudeAliveIn is
// fail-OPEN (returns true on ANY cmux socket error) — correct for the CLOSE
// path (never kill a maybe-alive tab) but UNSAFE for adoption: a transient
// socket error would adopt a DEAD workspace and report a launch that never
// happened. Require a SUCCESSFUL workspace listing that still contains the ref
// before trusting the process check, so a socket failure yields "not alive"
// (report the failure) instead of "adopt the corpse".
function strictlyAliveWorkspace(ref, marker) {
  try {
    if (!cmuxws.listWorkspaces().some(w => w.ref === ref)) return false;
    return cmuxws.claudeAliveIn(ref) && osProcessAliveForSeed(marker);
  } catch { return false; }
}

// Cross-check cmux's own "claude_code tag alive" signal against a REAL OS
// process (card #548, false positive 2026-07-26): `cmux top --processes`
// reports off cmux's own terminal-surface/tag registry, which can desync from
// what's actually running — workspace:115 (#545) had claudeAliveIn()===true
// and a "Running" claude_code tag while capture-pane/read-screen/pipe-pane all
// failed "Terminal surface not found" and `ps aux` had ZERO matching claude
// processes. The bash wrapper this module writes to `cmdFile` runs as the
// foreground parent of the real claude process for the session's whole
// lifetime, so its presence in the OS process table is ground truth,
// independent of cmux's internal bookkeeping, that a real process exists for
// THIS launch specifically (not just some possibly-stale/misattributed tag).
//
// `marker` is the exact basename of THIS launch's cmdFile (nonce-suffixed —
// see launchCmuxSession), not just the caller's seedKey: seedKey is often
// task.id, which is IDENTICAL across every dispatch attempt of the same task
// (adversarial review, 2026-07-26 — two concurrently-live bash wrappers for
// the same #545 seedKey were found on the host, left over from separate
// dispatch attempts). Matching on the bare seedKey would let a stale leftover
// process from an OLDER, unrelated attempt confirm a NEW workspace's cmux tag
// — the exact false-positive class this fix exists to close. The nonce makes
// the marker unique per launchCmuxSession() call, so a match only proves a
// process from THIS launch attempt is alive.
function hasSeedProcess(psText, marker) {
  return String(psText).split('\n').some(line => line.includes(marker));
}

function osProcessAliveForSeed(marker) {
  try {
    // -ww: unlimited width, so a long command line isn't truncated before the
    // marker. -e: every process, not just this terminal's. maxBuffer raised
    // from spawnSync's 1MB default — measured ~500KB-1MB+ on a host running a
    // dozen claude sessions (each session's full seed prompt is its own
    // argv), and a default-sized buffer silently truncates output near the
    // END of the process list without setting a non-zero exit status,
    // producing a false "not alive" that would close/refuse a healthy launch
    // (adversarial review, 2026-07-26). timeout guards a wedged ps hang.
    const r = spawnSync('ps', ['-e', '-ww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5000 });
    if (r.error || (r.status !== 0 && !r.stdout)) return false; // ps failed/timed out/truncated — fail CLOSED (verifying a POSITIVE claim, unlike claudeAliveIn's close-path fail-open)
    return hasSeedProcess(r.stdout || '', marker);
  } catch {
    return false;
  }
}

// Combined liveness gate for the launch-verification poll: cmux's tag/process
// registry AND a real OS process for this launch's marker both have to
// agree. Either signal alone has a known false-positive mode (cmux's
// registry per #548 above; a bash wrapper alone only proves SOME process for
// this marker is alive) — requiring both is what makes "claude verified
// running" true.
function verifiedAlive(ws, marker) {
  return !!(ws && cmuxws.claudeAliveIn(ws.ref) && osProcessAliveForSeed(marker));
}

// Drive the wait/retry state machine (cmux-launch-state.js) against live
// probes until it says something other than "wait". Two probes per poll, and
// the cmux tag check is skipped entirely when no wrapper process exists (it
// cannot be a verified launch without one, and skipping saves a cmux round
// trip on every poll of a dead attempt).
//
// wrapperEverSeen is per-ATTEMPT state and lives here rather than in the pure
// decision: "the wrapper ran and then died" is only distinguishable from
// "the wrapper never ran" by remembering earlier polls.
function waitForLaunchOutcome({ ws, marker, attempt, maxAttempts, injectionGraceSec, slowBootCapSec, wakeAfterSec = WAKE_AFTER_SEC, wakeFn = null, probes = {} }) {
  const wrapperProbe = probes.wrapperAlive || osProcessAliveForSeed;
  const tagProbe = probes.claudeTagAlive || (ref => cmuxws.claudeAliveIn(ref));
  // probes.wake is the TEST seam and wins; wakeFn is how launchCmuxSession
  // observes fire-time (it must learn a wake happened even if this wait is
  // later interrupted by a throw — outcome-based tracking would leak the
  // override on any non-return path).
  const wake = probes.wake || wakeFn || (isFirstWake => { if (!isFirstWake) osActivateCmuxApp(); return setAppFocus('active'); });
  const napSec = probes.intervalSec ?? PROBE_INTERVAL_SEC; // ?? not ||: a test seam of 0 must mean "don't sleep"
  // MONOTONIC clock, not Date.now (Codex ship-check): an NTP step or a manual
  // clock change during a 6-minute wait would otherwise move elapsed backward
  // (wait forever) or forward (kill a healthy boot early).
  const now = probes.now || (() => Number(process.hrtime.bigint() / 1000000n));

  const startedAt = now();
  let wrapperFirstSeenAt = null;
  let wrapperEverSeen = false;
  let missStreak = 0;
  let announced = null;
  let wakeAttempted = false;
  let nextWakeAtSec = wakeAfterSec;
  let effectiveGraceSec = injectionGraceSec;
  for (;;) {
    const sampleAlive = wrapperProbe(marker);
    if (sampleAlive) {
      if (!wrapperEverSeen) wrapperFirstSeenAt = now();
      wrapperEverSeen = true; missStreak = 0;
    } else { missStreak += 1; }
    // Debounce the ps probe once the wrapper HAS been seen (ship-check, GPT
    // reviewer): osProcessAliveForSeed fails CLOSED on a ps error, truncation
    // or timeout, so one unlucky sample would read as "the wrapper died" and
    // — before the tag veto below — close and relaunch a healthy session.
    // A process that really exited stays missing, so requiring consecutive
    // misses costs only PROBE_INTERVAL_SEC on a genuine death.
    const wrapperAlive = sampleAlive || (wrapperEverSeen && missStreak < WRAPPER_MISS_STREAK);
    // verifiedAlive's both-signals rule (card #548) restated in terms of the
    // probes already taken: cmux's tag alone has a known false-positive mode.
    const tagAlive = !!(ws && tagProbe(ws.ref));
    const claudeRegistered = !!(wrapperAlive && tagAlive);
    const stamp = now();
    const elapsedSec = (stamp - startedAt) / 1000;
    // The boot budget starts when the command actually STARTED, not when the
    // workspace was created — otherwise a slow injection eats the boot window
    // it was supposed to protect (Codex ship-check).
    const bootElapsedSec = wrapperFirstSeenAt === null ? null : (stamp - wrapperFirstSeenAt) / 1000;
    // Deferred-render wake (see setAppFocus): if the wrapper has NEVER been
    // seen by wakeAfterSec, the likeliest cause is cmux deferring the surface
    // because the app is backgrounded, not a swallowed injection. The FIRST
    // wake also restarts the injection grace: the original grace was budgeted
    // for type-into-pane latency, but a woken tab must additionally render
    // its surface from scratch and run shell init — possibly alongside every
    // other deferred tab flushing at once. Re-fires every REWAKE_INTERVAL_SEC
    // in case a concurrent launcher's clear re-deferred a still-unrendered
    // surface.
    if (!wrapperEverSeen && elapsedSec >= nextWakeAtSec) {
      const isFirstWake = !wakeAttempted;
      if (isFirstWake) {
        effectiveGraceSec = elapsedSec + injectionGraceSec;
        console.error(`[cmux-launch] ${ws ? ws.ref : 'workspace'}: no wrapper process after ${Math.round(elapsedSec)}s — forcing app-focus active to flush cmux's deferred surface render (lazy-exec fix, 2026-08-02); injection grace restarted`);
      }
      wakeAttempted = true;
      nextWakeAtSec = elapsedSec + REWAKE_INTERVAL_SEC;
      wake(isFirstWake);
    }
    const d = decideLaunchWait({
      claudeRegistered, wrapperAlive, wrapperEverSeen, tagAlive, elapsedSec, bootElapsedSec,
      attempt, maxAttempts, injectionGraceSec: effectiveGraceSec, slowBootCapSec,
    });
    if (d.action !== 'wait') return { ...d, wrapperAlive, tagAlive, wakeAttempted, elapsedSec: Math.round(elapsedSec) };
    if (d.state !== announced) {
      announced = d.state;
      if (d.state === STATES.LAUNCHING_SLOW) {
        console.error(`[cmux-launch] ${ws ? ws.ref : 'workspace'}: command is RUNNING (wrapper process alive) but claude has not registered yet — waiting up to ${slowBootCapSec}s, will NOT relaunch (card #705)`);
      }
    }
    sleepSec(napSec);
  }
}

// A launch result is adoptable when it FAILED verification but left a real
// workspace behind that is now demonstrably alive — i.e. claude registered
// after the verify window, not never.
function shouldAdoptLateStart(result, isAlive) {
  return !!(result && !result.ok && result.workspaceRef && isAlive);
}

// Pure gate decision for the auth preflight (card #856) — extracted so the
// refusal logic is unit-testable without spawning a real `claude` process.
function shouldRefuseForAuth(auth) {
  return !!(auth && auth.ok === false);
}

/**
 * Launch a cmux workspace running `claude` on a seed prompt and verify a live
 * claude process actually started.
 *
 * @param {object} opts
 * @param {string} opts.title      workspace tab title (caller owns naming convention)
 * @param {string} opts.seed       full seed prompt text
 * @param {string} opts.seedKey    unique key for the temp seed/cmd filenames (bsc-next passes task.id)
 * @param {string} opts.cwd        working directory for the workspace
 * @param {string} [opts.model]    claude model (default sonnet — dispatched sessions
 *                                 never inherit the interactive default; 9 Fable
 *                                 workspaces in one night, 2026-07-13)
 * @param {boolean} [opts.focus]   focus the new tab (default true; false for
 *                                 late-night unattended launches — never steal
 *                                 the owner's screen)
 * @param {boolean} [opts.autoColor] color the tab Blue as auto-dispatched
 * @param {string}  [opts.settingsPath] optional --settings deny-list file
 * @param {string}  [opts.commandOverride] test seam — never set in real use
 * @param {number}  [opts.verifyTimeoutSec] seconds to wait for the TYPED COMMAND
 *                                 to start (this launch's wrapper process
 *                                 appearing in the process table) before
 *                                 concluding the injection never ran. It is no
 *                                 longer the whole verification budget: once
 *                                 the wrapper is up, slowBootCapSec governs.
 *                                 Default 30 (sonnet cold start). Fable +
 *                                 heavy session-start hooks need ~60-90s —
 *                                 the first live monitor launch (2026-07-24)
 *                                 came alive AFTER the 30s window, got its
 *                                 workspace close-and-retried, and left an
 *                                 untracked live session behind.
 * @param {number}  [opts.slowBootCapSec] seconds a STARTED launch may spend
 *                                 booting claude before the call gives up.
 *                                 Never triggers a relaunch — a live wrapper
 *                                 means a live boot (card #705). Default 360.
 * @param {object}  [opts.probes]  test seam: {wrapperAlive, claudeTagAlive,
 *                                 wake, intervalSec, now} — never set in real
 *                                 use. Tests calling waitForLaunchOutcome
 *                                 directly MUST pass probes.wake (a no-op),
 *                                 or a local test run fires a REAL
 *                                 `set-app-focus active` with no clear.
 * @param {number}  [opts.lateAdoptSec] seconds to keep watching a FAILED
 *                                 launch's leftover workspace before calling
 *                                 it dead. A claude that registers here is
 *                                 healthy-but-slow, not a corpse: adopt it
 *                                 (ok:true, adoptedLate:true) instead of
 *                                 reporting a false failure the caller then
 *                                 "fixes" by dispatching a duplicate.
 *                                 0 = off (legacy behavior).
 * @returns {{ok: boolean, ref?: string, adoptedLate?: boolean, state?: string, reason?: string, wrapperAlive?: boolean, deadConfirmed?: boolean, workspaceRef?: string|null, seedFile: string, command: string}}
 */
function launchCmuxSession(opts) {
  // The deferred-render wake (setAppFocus 'active') is a PERSISTENT override;
  // clear it however the launch ends so cmux isn't permanently blinded to the
  // app's real focus state. Cleared only when a wake actually fired — an
  // unconditional clear would stomp a concurrent launcher's active window.
  const wakeState = { woke: false };
  try {
    return launchCmuxSessionInner(opts, wakeState);
  } finally {
    if (wakeState.woke) setAppFocus('clear');
  }
}

// Best-effort digest page for a launch refused at the auth gate (card #856).
// Never lets an alerting failure mask or block the real launch-failure
// report — routeAlert's disposition:'digest' branch does its fs write
// synchronously before any `await` in its body, so this fire-and-forget call
// is durable by the time launchCmuxSessionInner returns, even though the
// caller (bsc-next.js) may process.exit() moments later.
function pageAuthPreflightFailure(detail) {
  try {
    const { routeAlert } = require('./owner-alert-router.js');
    routeAlert({
      conditionKey: 'cmux-launch:auth-preflight-failed',
      title: 'cmux launch refused — claude auth preflight failed',
      description: detail,
      severity: 'error',
      disposition: 'digest',
      cooldownHours: 6,
    }).catch(() => {});
  } catch { /* alerting must never block reporting the real launch failure */ }
}

function launchCmuxSessionInner({ title, seed, seedKey, cwd, model = 'sonnet', focus = true, autoColor = false, settingsPath = null, commandOverride = null, verifyTimeoutSec = 30, lateAdoptSec = 0, slowBootCapSec = DEFAULT_SLOW_BOOT_CAP_SEC, skipAuthPreflight = false, probes = {} }, wakeState = { woke: false }) {
  // Naming-convention floor (owner escalation 2026-08-06): a glyphless bare
  // title is decorated with 🤖 + the model glyph; titles that already lead
  // with a glyph (🤖/👑/✅/…) pass through untouched — see ensureAutoTitle.
  const normalizedTitle = ensureAutoTitle(title, model);
  if (normalizedTitle !== title) {
    console.error(`[cmux-launch] bare title auto-decorated to house convention: "${title}" → "${normalizedTitle}"`);
    title = normalizedTitle;
  }
  const seedFile = path.join(os.tmpdir(), `bsc-seed-${seedKey}.txt`);
  fs.writeFileSync(seedFile, seed);
  // The wrapper script expands $(cat …) so the multi-line prompt survives
  // without brittle inline quoting. `claude "<prompt>"` opens interactive on it.
  const command = commandOverride || buildLaunchCommand(model, settingsPath, seedFile);
  // Shell-init race (real failure 2026-07-12): new-workspace TYPES the command
  // into the pane while zsh/direnv may still be initializing, so leading
  // keystrokes get swallowed ('nclaude' → command not found) and the session
  // never starts. Shrink the typed surface to a short constant string by
  // putting the real command in a script file.
  // Nonce-suffixed (card #548 adversarial review, 2026-07-26): seedKey alone
  // (task.id) is IDENTICAL across every dispatch attempt of the same task —
  // two concurrently-live bash wrappers for the same seedKey were found on
  // the host, left over from separate dispatch attempts. Without the nonce, a
  // stale leftover process from an OLDER attempt could satisfy the OS-process
  // cross-check below for a NEW, actually-dead workspace whose cmux tag is
  // (independently) falsely alive — reproducing the exact false positive this
  // cross-check exists to close. The nonce makes the marker unique per
  // launchCmuxSession() call, so a match only proves a process from THIS call
  // is alive.
  const launchNonce = crypto.randomBytes(4).toString('hex');
  const cmdFile = path.join(os.tmpdir(), `bsc-cmd-${seedKey}-${launchNonce}.sh`);
  const cmdMarker = path.basename(cmdFile);
  fs.writeFileSync(cmdFile, `#!/bin/bash\n${command}\n`);
  const typed = ` bash ${cmdFile}`; // leading space additionally survives a swallowed first key
  if (!fs.existsSync(CMUX)) return { ok: false, reason: 'cmux CLI not found', seedFile, command };

  // Launcher auth pre-check (card #856, Session-system overhaul S3): 7 cmux
  // launches died to "Not logged in" in the 5 days before this fix, and
  // silently — a new pane's claude process registers (claudeAliveIn/
  // hasClaudeChrome both go true), boots, and just sits on a login prompt,
  // which every liveness check in this file reads as a healthy launch.
  // preflightAuth() (scripts/lib/claude-cli.js, task #713) already solves
  // exactly this for headless spawns by probing the real auth shape before
  // spending a session attempt; reuse it here instead of re-inventing a
  // pane-content probe. Fails CLOSED: refuse to open a doomed tab rather
  // than let the owner discover it later. Kill switch matches the existing
  // DEPLOY_GATE_DISABLED pattern — default OFF (preflight active) until this
  // soaks; flip only if the probe itself proves flaky, never as a permanent
  // bypass.
  if (!skipAuthPreflight && process.env.CMUX_AUTH_PREFLIGHT_DISABLED !== '1') {
    const auth = preflightAuth({ log: msg => console.error(`[cmux-launch] ${msg}`) });
    if (shouldRefuseForAuth(auth)) {
      const reason = `claude auth preflight failed — ${auth.detail || 'no working credential'}`;
      console.error(`[cmux-launch] REFUSING launch "${title}": ${reason}`);
      pageAuthPreflightFailure(reason);
      return { ok: false, reason, authPreflightFailed: true, seedFile, command };
    }
  }

  // The SURVIVING workspace — the one attempt 2 left open. Deliberately reset
  // per attempt (Opus ship-check blocker, Codex): carrying attempt 1's ref
  // forward with `lastWs = ws || lastWs` meant that if attempt 2 could not
  // resolve its own ref, both the late-adopt watch and the caller's failure
  // journaling pointed at attempt 1's workspace — which this function CLOSED
  // at line ~156 — while attempt 2's real, possibly-alive workspace stayed
  // completely unattributed. Attribution is the whole point of the fix, so an
  // unresolvable workspace must report null (honest "we don't know") rather
  // than a confidently wrong, already-closed ref.
  let survivingWs = null;
  let outcome = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    survivingWs = null;
    const before = new Set(cmuxws.listWorkspaces().map(w => w.ref));
    // Idle-gated PRE-wake (card #1199 — see shouldPreWake). Marker is stamped
    // BEFORE the wake, not after the spawn, so a sibling launcher starting a
    // second later already reads "busy" and skips its own pre-wake: that is
    // what keeps the finally-clear correlated with idle launches instead of
    // firing across a concurrent batch.
    const idleSec = (probes.idleSec || cmuxIdleSec)();
    noteLaunchAttempt();
    if (shouldPreWake({ idleSec, attempt })) {
      console.error(`[cmux-launch] pre-waking cmux before create (${Number.isFinite(idleSec) ? `${Math.round(idleSec)}s since last launch` : 'no recent launch'}, attempt ${attempt}) — deferred surfaces never run their --command (card #1199)`);
      wakeState.woke = true;
      (probes.wake || (() => setAppFocus('active')))(true);
    }
    const r = spawnSync(CMUX, ['new-workspace', '--name', title, '--cwd', cwd, '--command', typed, '--focus', String(focus)],
      { encoding: 'utf8' });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.status !== 0) {
      if (r.stderr) process.stderr.write(r.stderr);
      if (attempt === 1) { sleepSec(2); continue; }
      return { ok: false, reason: `cmux exited ${r.status}`, seedFile, command };
    }
    // Resolve the created workspace: new-workspace prints "OK workspace:N"
    // (cmux 0.64.6); fall back to a before/after list diff if that changes.
    const m = /workspace:\d+/.exec(String(r.stdout || ''));
    const ws = m ? { ref: m[0] } : pollUntil(
      () => cmuxws.listWorkspaces().find(w => !before.has(w.ref)), 5);
    survivingWs = ws || null;
    // Progress output: a failed dispatch now costs up to ~4 minutes (two 90s
    // verify windows plus a 60s adoption grace). Silence for that long reads
    // as a hung CLI, so say what is being waited on.
    if (ws) console.error(`[cmux-launch] ${ws.ref} created — waiting up to ${verifyTimeoutSec}s for the command to start, then up to ${slowBootCapSec}s for claude to register (attempt ${attempt}/${MAX_ATTEMPTS})`);
    // VERIFY the launch (scope add 3): a workspace whose command was mangled
    // never starts claude and never self-marks ✅, so nothing would notice.
    // The verdict is the state machine's, not a stopwatch's (card #705) — see
    // waitForLaunchOutcome. verifyTimeoutSec is the window for the typed
    // command to START (wrapper process appears); slowBootCapSec is how long a
    // started-but-unregistered claude is allowed to boot.
    outcome = waitForLaunchOutcome({
      ws, marker: cmdMarker, attempt, maxAttempts: MAX_ATTEMPTS,
      injectionGraceSec: verifyTimeoutSec, slowBootCapSec, probes,
      // woke is recorded AT FIRE TIME, not from the returned outcome — a
      // throw/interrupt between the wake and the return would otherwise skip
      // the finally-clear and leave the override pinned.
      // OS-level activation (open -a) only from the SECOND wake onward — not
      // the first (P1, Codex adversarial review 2026-08-03): calling it on
      // every 5s-delayed launch would steal screen focus for the common
      // brief-lag case (#705 measured 4-5 min boots as normal under load),
      // not just a genuine outage. First wake stays exactly as #849 shipped
      // it (internal cmux flag only); escalating to a real OS foreground is
      // reserved for a launch that is STILL not injecting ~10s+ later.
      wakeFn: isFirstWake => { wakeState.woke = true; if (!isFirstWake) osActivateCmuxApp(); return setAppFocus('active'); },
    });
    if (outcome.action === 'ok') {
      if (autoColor) setAutoColor(ws.ref);
      return { ok: true, ref: ws.ref, state: outcome.state, seedFile, command };
    }
    if (outcome.action === 'retry') {
      // DISPROVED 2026-08-13 (owner decision, Option A). The premise this
      // branch was built on — "only reachable when NOTHING of this attempt is
      // running" — is false, and the close below was destroying LIVE sessions.
      //
      // Reproduced on demand by scripts/probe-cmux-launch.js, twice, in
      // daylight: a `touch M` payload returned injection-never-ran while the
      // marker file existed (the command HAD run), and a `touch M; sleep 180`
      // payload had attempt 1 return injection-never-ran and close the
      // workspace, after which attempt 2 logged "command is RUNNING (wrapper
      // process alive)". Same code, same machine, opposite verdicts seconds
      // apart: the wrapper probe misses wrappers that exist.
      //
      // So this verdict cannot justify a destructive action. We keep the
      // workspace and STOP relaunching. Dropping the retry is not optional —
      // preserving the workspace while still relaunching is exactly the
      // duplicate factory the old comment warned about (both tabs boot on the
      // next foreground). A genuinely-dead tab now lingers until bsc-prune,
      // which is strictly cheaper than killing a live session's work.
      console.error(`[cmux-launch] attempt ${attempt} reported ${outcome.state} for ${ws ? ws.ref : 'nothing'} — NOT closing and NOT relaunching (the probe is unreliable; see scripts/probe-cmux-launch.js). Leaving it for late-adopt.`);
      break;
    }
    break; // 'fail' — keep survivingWs for the caller (and the late-adopt watch)
  }
  const slowBoot = isSlowBootFailure(outcome && outcome.state);
  const failed = {
    ok: false,
    state: (outcome && outcome.state) || STATES.INJECTION_NEVER_RAN,
    // Distinct reasons, so callers and logs stop reporting every slow launch
    // as "cmux is dead" (card #705: that conflation is what made the owner
    // see "cmux breaks at least once a day").
    reason: `${(outcome && outcome.reason) || 'launch not verified'} in ${survivingWs ? survivingWs.ref : 'the new workspace'}`,
    // The wrapper is still running for a slow-boot failure: the workspace is
    // NOT a corpse, must not be closed, and must not be journaled as a death.
    wrapperAlive: !!(outcome && outcome.wrapperAlive),
    deadConfirmed: !slowBoot,
    workspaceRef: survivingWs ? survivingWs.ref : null,
    seedFile, command,
  };

  // Late-start adoption (task #503, generalized from the monitor launcher's
  // 2026-07-24 fix): the attempt-2 workspace is NOT closed above, so a claude
  // that registers a few seconds past the verify window keeps running while
  // the caller is told the launch died. Every such false failure produced an
  // untracked, unjournaled live shell AND a duplicate dispatch onto the same
  // task (10 of them on 2026-07-26). Watch the survivor here instead. Card
  // #705's slow-boot wait absorbs most of this, but the grace still buys a
  // claude that registers moments after the cap — and costs nothing when the
  // launch really is dead.
  if (lateAdoptSec > 0 && failed.workspaceRef) {
    console.error(`[cmux-launch] ${failed.state} — watching ${failed.workspaceRef} for a further ${lateAdoptSec}s before returning it unverified`);
    const live = pollUntil(() => strictlyAliveWorkspace(failed.workspaceRef, cmdMarker), lateAdoptSec);
    if (shouldAdoptLateStart(failed, live)) {
      if (autoColor) setAutoColor(failed.workspaceRef);
      return { ok: true, ref: failed.workspaceRef, adoptedLate: true, seedFile, command };
    }
  }
  return failed;
}

module.exports = {
  launchCmuxSession, CMUX, CMUX_APP, pollUntil, sleepSec, setAutoColor, setAppFocus,
  osActivateCmuxApp, strictlyAliveWorkspace, shouldAdoptLateStart, waitForLaunchOutcome,
  hasSeedProcess, osProcessAliveForSeed, verifiedAlive, shouldRefuseForAuth,
  buildLaunchCommand,
  MAX_ATTEMPTS, PROBE_INTERVAL_SEC, WRAPPER_MISS_STREAK, WAKE_AFTER_SEC,
  REWAKE_INTERVAL_SEC,
  shouldPreWake, cmuxIdleSec, noteLaunchAttempt, IDLE_GATE_SEC, LAST_LAUNCH_MARKER,
};
