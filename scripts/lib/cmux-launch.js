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
const { decideLaunchWait, isSlowBootFailure, STATES, REASONS,
  shouldProbeSurface, shouldReprobeCapacity,
  DEFAULT_SLOW_BOOT_CAP_SEC } = require('./cmux-launch-state.js');
const { preflightAuth } = require('./claude-cli.js');
const { ensureAutoTitle } = require('./workspace-naming.js');
const terminalCapacity = require('./cmux-terminal-capacity.js');

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

// Cross-INVOCATION reclaim journal (task #1706). lateAdoptSec's watch is
// scoped to a single launchCmuxSession() call: once its grace window expires
// with the workspace still not verified, the function returns `failed` and
// forgets the workspace ever existed. If that workspace registers claude a
// few seconds later — the exact "genuinely started late" case this session's
// live BRO-343 crown handoff reproduced (three concurrently-live dispatcher
// sessions on one mandate, 2026-08-16) — nothing links the next, separate
// launchCmuxSession() call for the same work back to it, so the retry opens a
// second real session. This file is that link: a failed launch with a real
// workspaceRef writes an entry here keyed by the caller's work identity
// (workKey opt, defaulting to seedKey — see its @param note below for why
// they're kept distinct); the next launchCmuxSession() call for that same key
// checks the entry BEFORE creating anything and adopts it if strictlyAliveWorkspace()
// (the fail-closed, both-signals-required probe already used by the in-call
// lateAdoptSec watch) confirms it live.
//
// A flat per-workKey object (latest-outstanding-failure, not an event log) —
// deliberately NOT appended to dispatch-ledger.js, which many other
// consumers (checkDeadDispatch, parkedGuard, ...) already scan with their own
// assumptions about what a ledger row means; conflating "current unresolved
// orphan" with that audit trail would risk perturbing them. Self-clearing
// (below) keeps this bounded in practice: an entry only survives if its
// workKey is NEVER dispatched again, and at a few hundred bytes each even
// thousands of abandoned entries are noise.
//
// Concurrency: read-modify-write, not locked or fsync'd. Two
// launchCmuxSession() calls racing for the SAME workKey can both read "no
// entry", both launch, and the loser's write can clobber the winner's — this
// does not protect the truly-concurrent case (only sequential retries, which
// is what the reproducing incident was). Crucially, every failure mode here
// degrades to PRE-FIX behavior (a launch attempted with no reclaim), never to
// a WRONG reclaim: reclaim only fires when a read finds an entry AND
// strictlyAliveWorkspace() independently confirms it live right now, so a
// lost/never-written/corrupt entry just means "nothing to reclaim", the
// status quo before this file existed. writeFileSync is a single syscall (no
// separate truncate+write), so a reader never observes a half-written file;
// JSON.parse failure is treated as "no entries" for the same reason.
// CMUX_LAUNCH_RECLAIM_DISABLED=1 fully disables reads AND writes (kill
// switch, matching the CMUX_AUTH_PREFLIGHT_DISABLED convention below) if this
// ever needs to be pulled — it reverts every call to exactly pre-#1706
// behavior with no manual tmpfile cleanup required.
const LAUNCH_JOURNAL_PATH = path.join(os.tmpdir(), 'bsc-cmux-launch-journal.json');

function launchReclaimDisabled() {
  return process.env.CMUX_LAUNCH_RECLAIM_DISABLED === '1';
}

function readLaunchJournal(journalPath = LAUNCH_JOURNAL_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch { return {}; } // missing/corrupt journal is "no prior failure on record", not an error
}

function readLaunchJournalEntry(workKey, journalPath = LAUNCH_JOURNAL_PATH) {
  if (launchReclaimDisabled()) return null;
  return readLaunchJournal(journalPath)[String(workKey)] || null;
}

// Best-effort — a journal write failure must never block reporting the real
// launch failure it's trying to record (same posture as noteLaunchAttempt
// above). Losing an entry only means the NEXT retry misses reclaim and falls
// back to today's behavior; it can never cause a false adoption. Written via
// a same-directory temp file + atomic rename (not a direct writeFileSync) so
// a crash or a colliding writer mid-write can never leave a truncated/partial
// JSON file for a concurrent reader to trip over.
function writeLaunchJournalEntry(workKey, entry, journalPath = LAUNCH_JOURNAL_PATH) {
  if (launchReclaimDisabled()) return;
  try {
    const journal = readLaunchJournal(journalPath);
    journal[String(workKey)] = entry;
    const tmpPath = `${journalPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(journal));
    fs.renameSync(tmpPath, journalPath);
  } catch (e) {
    console.error(`[cmux-launch] WARN could not persist launch journal entry for "${workKey}" (${e.message}) — cross-invocation reclaim will miss this failure`);
  }
}

// Dropped once found dead (not alive) or successfully reclaimed — either way
// it must not keep answering future lookups for a workspace that's already
// been dealt with.
function clearLaunchJournalEntry(workKey, journalPath = LAUNCH_JOURNAL_PATH) {
  try {
    const journal = readLaunchJournal(journalPath);
    if (String(workKey) in journal) {
      delete journal[String(workKey)];
      fs.writeFileSync(journalPath, JSON.stringify(journal));
    }
  } catch { /* best-effort cleanup only */ }
}

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
//
// Card #1829: cmux's tag/process registry (claudeAliveIn) and a live OS
// wrapper process (osProcessAliveForSeed) can BOTH read positive for a
// workspace whose terminal surface never rendered — that's precisely the
// #1199 deferred-render failure mode this file's own header already
// documents for workspace:115 (tag "Running" + capture-pane/read-screen ALL
// reporting "Terminal surface not found"). Neither existing signal here
// queries the rendered surface at all, so this function adopted 7/7 dead
// cmux-tab dispatches on 2026-08-19 as ok:true with nothing actually running.
// terminalSurfaceConfirmedMissing queries cmux's read-screen directly and
// only reports true on a CONFIRMED not-found (a successful read, or any
// other error, leaves this false — fail-open), so requiring its inverse here
// adds a genuinely independent, authoritative signal without making this
// check more failure-prone than it already is. NOT terminalSurfaceAliveIn:
// that helper requires the claude status-bar chrome to be painted, which is
// the wrong bar for a check that must not false-fail a workspace whose
// surface is real but whose UI hasn't drawn its first frame yet (adversarial
// review, 2026-08-19 — see terminalSurfaceConfirmedMissing's own header).
function defaultSurfaceAliveFn(ref) {
  return !cmuxws.terminalSurfaceConfirmedMissing(ref);
}

// Pure AND-gate over the 4 signals (rule 15 — extracted so the "surface is
// now required" behavior is directly unit-testable without a real cmux
// socket or OS process table). listed=false always means dead regardless of
// the other three: a ref that isn't even in listWorkspaces() can't be alive
// by any definition.
function computeStrictAliveness({ listed, claudeAlive, osProcessAlive, surfaceAlive }) {
  return !!(listed && claudeAlive && osProcessAlive && surfaceAlive);
}

function strictlyAliveWorkspace(ref, marker, probes = {}) {
  const surfaceAliveFn = probes.terminalSurfaceAlive || defaultSurfaceAliveFn;
  try {
    const listed = cmuxws.listWorkspaces().some(w => w.ref === ref);
    if (!listed) return false;
    return computeStrictAliveness({
      listed,
      claudeAlive: cmuxws.claudeAliveIn(ref),
      osProcessAlive: osProcessAliveForSeed(marker),
      surfaceAlive: surfaceAliveFn(ref),
    });
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

// One `ps` sample, reusable across many markers (BRO-2575). A bsc-prune sweep
// tests every idle dispatched workspace at once; re-running `ps -e` per
// workspace would be ~25 full process-table dumps per 5-minute tick for
// identical data. Returns a predicate over markers.
//
// Fails CLOSED exactly like osProcessAliveForSeed below (which is now defined
// in terms of this, so the two can never drift): if ps itself failed, every
// marker reports not-alive. Both callers treat "not alive" as "no positive
// evidence of life", never as proof of death — the launch path already
// required a second signal to agree, and deadBreadcrumbs falls back to the
// pre-existing cmux verdict rather than inventing one.
// The sample is taken LAZILY, on the first marker tested, and memoized for the
// probe's lifetime: callers (checkDeadDispatch) can hand this to a code path
// that may never test a marker at all, and a dispatch that finds nothing idle
// must not pay for a process-table dump.
// sampleFn is a test-only seam (same pattern as this file's other probes) so
// the memoization is provable by COUNTING calls rather than by timing them —
// a timing assertion is scheduler folklore and would flake in CI.
function makeSeedProcessProbe(sampleFn = null) {
  let text = '';
  let ok = false;
  let sampled = false;
  function sample() {
    sampled = true;
    if (sampleFn) {
      try {
        const out = sampleFn();
        ok = typeof out === 'string';
        text = ok ? out : '';
      } catch { ok = false; }
      return;
    }
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
      // ps failed/timed out/truncated — fail CLOSED (verifying a POSITIVE claim,
      // unlike claudeAliveIn's close-path fail-open)
      ok = !(r.error || (r.status !== 0 && !r.stdout));
      text = r.stdout || '';
    } catch {
      ok = false;
    }
    // Never silent (ship-check P2): with ok=false every marker reports
    // not-alive, so the whole fleet quietly reverts to the cmux-only verdict
    // this check exists to correct. A third signal that has switched itself off
    // must say so — once per probe, not once per marker.
    if (!ok) console.error('[cmux-launch] WARN process-table read failed — wrapper liveness unavailable; callers fall back to cmux-only liveness');
  }
  return (marker) => {
    if (!sampled) sample();
    return ok ? hasSeedProcess(text, marker) : false;
  };
}

function osProcessAliveForSeed(marker) {
  return makeSeedProcessProbe()(marker);
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
//
// startedProbe (card #1812) is a SECOND, independent way to learn the wrapper
// ever ran, alongside the ps-based wrapperProbe. Live-reproduced via
// scripts/probe-cmux-launch.js on this exact machine (2026-08-19): a fast
// payload's wrapper can complete and exit entirely BETWEEN two 3s ps
// snapshots, so osProcessAliveForSeed never once samples it alive — the
// launcher reports INJECTION_NEVER_RAN while a ground-truth marker file
// proves the command DID run. A snapshot-based probe can structurally miss a
// transient process; a marker FILE the wrapper touches as its very first
// action cannot un-happen once written, so fs.existsSync can never miss it
// the way a point-in-time `ps` sample can. This only widens wrapperEverSeen
// (OR'd with the existing signal) — the ongoing wrapperAlive/missStreak
// liveness debounce below is untouched, so WRAPPER_EXITED detection (did it
// die after starting) still depends solely on the real ps signal.
function waitForLaunchOutcome({ ws, marker, attempt, maxAttempts, injectionGraceSec, slowBootCapSec, wakeAfterSec = WAKE_AFTER_SEC, wakeFn = null, startedFile = null, probes = {} }) {
  const wrapperProbe = probes.wrapperAlive || osProcessAliveForSeed;
  const tagProbe = probes.claudeTagAlive || (ref => cmuxws.claudeAliveIn(ref));
  const startedProbe = probes.wrapperStarted || (() => {
    if (!startedFile) return false;
    try { return fs.existsSync(startedFile); } catch { return false; }
  });
  // Task #1904. The two signals that separate "cmux never attached a terminal
  // to this workspace" from "the injection is just slow": read-screen's
  // confirmed-missing verdict (the EXISTING primitive — cmux-workspaces.js's
  // terminalSurfaceConfirmedMissing, which is fail-OPEN, so a transient socket
  // error reads as "not confirmed missing") and the app-wide runtime count.
  const surfaceMissingProbe = probes.surfaceConfirmedMissing
    || (ref => cmuxws.terminalSurfaceConfirmedMissing(ref));
  // Returns {atCapacity, known}. `known` here means "the probe produced a live
  // runtime COUNT", which is NOT decideCapacity's `known` — that one is also
  // false in the perfectly ordinary "count fine, no confirmed ceiling yet"
  // state, and keying the re-ask on it would re-probe three times on every
  // healthy launch (/code-review, adopted). liveRuntimes === null is the only
  // reading that means "ask again".
  const capacityProbe = probes.atTerminalCapacity
    || (() => {
      const c = terminalCapacity.probeTerminalCapacity();
      return { atCapacity: c.hasCapacity === false, known: c.liveRuntimes !== null };
    });
  // A test seam predating this shape returns a bare boolean. Destructuring one
  // yields `atCapacity: undefined` — silently "not at capacity", with no throw
  // and no failing test. Normalize instead of trusting the shape.
  const readCapacityProbe = () => {
    const raw = capacityProbe();
    if (typeof raw === 'boolean') return { atCapacity: raw, known: true };
    if (raw && typeof raw === 'object') return { atCapacity: !!raw.atCapacity, known: raw.known !== false };
    return { atCapacity: false, known: false };
  };
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
  // Asked a bounded number of times, spaced out (shouldReprobeCapacity) rather
  // than once-and-cached: an unknown reading must not latch as "plenty of
  // room", and a known one goes stale because a dozen sessions dispatch on
  // this host in parallel. An unknown reading leaves the previous verdict
  // standing instead of overwriting it with a guess.
  let atTerminalCapacity = false;
  let capacityProbeAttempts = 0;
  let lastCapacityProbeSec = null;
  // The LAST read-screen verdict, carried between polls because the probe is
  // now throttled rather than run every 3s.
  //
  // Carried, but deliberately NOT latched sticky-true. It has to survive
  // between probes because it is the sole trigger for ceiling learning:
  // decideLaunchWait's grace-expiry branch uses it as a LABEL, and that label
  // (TERMINAL_RUNTIME_MISSING) is what launchCmuxSessionInner gates
  // recordCapacityOutcome('runtime-missing') on — recomputed from scratch each
  // poll, a non-probe deciding iteration would degrade it to
  // INJECTION_NEVER_RAN and the throttle would silently disable the whole fix.
  // But latching it FOREVER is the opposite error (adversarial review catch):
  // a healthy launch's runtime attach was measured as slow as 39.9s on this
  // machine, so a legitimate "no surface yet" at 15s would then still read as
  // missing at 30s, after the surface had actually appeared — and branch 3b
  // could kill a launch that was merely slow. A later probe must be able to
  // clear it. shouldProbeSurface's forced probe at grace expiry is what makes
  // "carried, not latched" safe: the deciding poll always reads fresh.
  let surfaceMissingVerdict = false;
  let lastSurfaceProbeSec = null;
  for (;;) {
    const sampleAlive = wrapperProbe(marker);
    if (sampleAlive) missStreak = 0; else missStreak += 1;
    // Card #1812: OR in the marker-file signal ONLY while still unresolved —
    // once wrapperEverSeen is true (via either signal) there is nothing left
    // to learn from it, so skip the extra fs.existsSync on every later poll.
    // missStreak stays driven SOLELY by sampleAlive (the real ps signal,
    // reset above) — the marker file, once written, never goes away, so
    // folding it into missStreak would permanently defeat WRAPPER_EXITED
    // detection for a wrapper that genuinely started and later died.
    if (!wrapperEverSeen && (sampleAlive || startedProbe())) {
      wrapperFirstSeenAt = now();
      wrapperEverSeen = true;
    }
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
    // Only asked while nothing of this launch has ever run — once the wrapper
    // has been seen, a terminal demonstrably exists and the whole question is
    // moot (and decideLaunchWait resolves WRAPPER_EXITED before it looks at
    // these anyway).
    if (!wrapperEverSeen && ws) {
      if (shouldProbeSurface({ elapsedSec, lastProbeSec: lastSurfaceProbeSec, graceSec: effectiveGraceSec })) {
        lastSurfaceProbeSec = elapsedSec;
        // try/catch for the same reason the preflight capacity call has one
        // (/code-review finding 8): this is a cmux IPC call inside the wait
        // loop, and an uncaught throw here would fail the launch outright —
        // the one outcome the fail-open design exists to rule out. A throw
        // reads as "not confirmed missing", matching the probe's own
        // fail-open contract.
        // A throw leaves the PREVIOUS verdict standing rather than flipping it
        // to false: an IPC error is "I couldn't ask", not "the surface is
        // there", and treating it as the latter would drop a real observation.
        try { surfaceMissingVerdict = !!surfaceMissingProbe(ws.ref); }
        catch (e) { console.error(`[cmux-launch] WARN surface probe threw (${e.message}) — keeping the previous surface verdict (${surfaceMissingVerdict})`); }
      }
      if (surfaceMissingVerdict
        && shouldReprobeCapacity({ attempts: capacityProbeAttempts, elapsedSec, lastProbeSec: lastCapacityProbeSec })) {
        capacityProbeAttempts += 1;
        lastCapacityProbeSec = elapsedSec;
        let reading = { atCapacity: false, known: false };
        try { reading = readCapacityProbe(); }
        catch (e) { console.error(`[cmux-launch] WARN terminal-capacity probe threw (${e.message}) — treating capacity as unknown`); }
        // Only a KNOWN reading moves the verdict. An unknown one leaves
        // whatever the last known answer was — never overwritten with a guess
        // in either direction.
        if (reading.known) {
          atTerminalCapacity = reading.atCapacity;
          if (atTerminalCapacity) {
            console.error(`[cmux-launch] ${ws.ref}: no terminal surface AND cmux is at its terminal-runtime ceiling — this workspace can never run its command (task #1904). Not retrying: the cap is app-wide.`);
          }
        }
      }
    }
    const surfaceConfirmedMissing = surfaceMissingVerdict;
    const d = decideLaunchWait({
      claudeRegistered, wrapperAlive, wrapperEverSeen, tagAlive, elapsedSec, bootElapsedSec,
      attempt, maxAttempts, injectionGraceSec: effectiveGraceSec, slowBootCapSec,
      surfaceConfirmedMissing, atTerminalCapacity,
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

// Fold a launch's verdict into the learned terminal-runtime ceiling (task
// #1904). Best-effort by construction: a scratch-file write must never be
// able to fail a launch that otherwise worked, and a ceiling that fails to
// persist just means the next dispatch re-learns it. The probe seam mirrors
// the wrapperAlive/claudeTagAlive convention used throughout this file.
function recordCapacityOutcome(liveRuntimesBefore, outcome, probes = {}) {
  if (!Number.isInteger(liveRuntimesBefore)) return null;
  const record = probes.recordCapacityOutcome || terminalCapacity.recordLaunchOutcome;
  try {
    const learned = record({ liveRuntimesBefore, outcome });
    if (learned && learned.changed) console.error(`[cmux-launch] ${learned.reason}`);
    return learned;
  } catch { return null; }
}

// Pure gate decision for the auth preflight (card #856) — extracted so the
// refusal logic is unit-testable without spawning a real `claude` process.
function shouldRefuseForAuth(auth) {
  return !!(auth && auth.ok === false);
}

// BRO-2251 (P0 regression, 2026-08-20): a manual crowned-successor handoff
// call passed seedKey=undefined and a cwd built from an undefined template
// variable — the caller's own string interpolation turned `undefined` into
// the literal path segment "undefined" (e.g. `${REPO}/${branchDir}` with
// branchDir undefined), producing a cwd like ".../Broadwayscore/undefined"
// that does not exist. Nothing downstream validated either: the seed file
// was written to the always-identical "bsc-seed-undefined.txt" (a collision
// hazard for any second concurrent bad call), and `cmux new-workspace --cwd
// <nonexistent dir>` silently created a workspace whose pty could never open
// that directory — confirmed live via `cmux debug-terminals`, which showed
// the resulting surface stuck at tty=nil/ghostty=nil while `read-screen`
// reported "Terminal surface not found". That is indistinguishable, from the
// caller's side, from the injection-never-ran false negative this file's
// header already documents — except this one was a real, always-reproducible
// caller bug with no gate catching it before a workspace got created.
//
// isUsableString rejects the stringified-undefined/null case specifically
// (not just emptiness) because that is exactly the failure shape a template
// literal produces — `` `${x}` `` on an undefined x yields the STRING
// "undefined", not the value undefined, so a plain typeof/truthiness check
// would have let this exact call through.
function isUsableString(v) {
  return typeof v === 'string' && v.length > 0 && v !== 'undefined' && v !== 'null';
}

// Checked before ANY side effect (no seed file, no cmd file, no workspace) so
// a bad caller call costs nothing and fails with a reason that names the bad
// argument, instead of leaving a dead tab in the sidebar that looks like a
// live launch attempt and only reports "injection never ran" after a full
// verify/late-adopt cycle.
function describeLaunchArgError({ seed, seedKey, cwd }) {
  if (!isUsableString(seedKey)) return `seedKey is required and must be a non-empty string (got ${JSON.stringify(seedKey)})`;
  if (typeof seed !== 'string' || !seed.length) return `seed is required and must be a non-empty string (got ${typeof seed})`;
  if (!isUsableString(cwd)) return `cwd is required and must be a non-empty string (got ${JSON.stringify(cwd)})`;
  return null;
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
 *                                 wake, intervalSec, now, idleSec,
 *                                 strictlyAlive, cmuxExists, cwdIsDir,
 *                                 newWorkspace} — never set in real use. Tests calling
 *                                 waitForLaunchOutcome directly MUST pass
 *                                 probes.wake (a no-op), or a local test run
 *                                 fires a REAL `set-app-focus active` with no
 *                                 clear.
 * @param {number}  [opts.lateAdoptSec] seconds to keep watching a FAILED
 *                                 launch's leftover workspace before calling
 *                                 it dead. A claude that registers here is
 *                                 healthy-but-slow, not a corpse: adopt it
 *                                 (ok:true, adoptedLate:true) instead of
 *                                 reporting a false failure the caller then
 *                                 "fixes" by dispatching a duplicate.
 *                                 0 = off (legacy behavior).
 * @param {string}  [opts.workKey] identity of the WORK this launch is for
 *                                 (task id / handoff subject) — defaults to
 *                                 seedKey, which is exactly what every
 *                                 in-repo caller passes today (bsc-next.js's
 *                                 seedKey is task.id, stable across retries),
 *                                 so reclaim applies to them with no caller
 *                                 changes. Kept as a SEPARATE opt rather than
 *                                 folding reclaim onto seedKey outright
 *                                 because the card #1706 incident report
 *                                 describes an ad-hoc/manual handoff dispatch
 *                                 that varied its seedKey between attempts
 *                                 (a "-b" suffix) — that exact path is not a
 *                                 caller in this repo as of this fix, but a
 *                                 future or external caller with the same
 *                                 pattern can still opt in to reclaim by
 *                                 passing a workKey that stays stable when
 *                                 seedKey doesn't, without this file having
 *                                 to guess at what "the same work" means.
 * @param {boolean} [opts.force]  caller intends to bypass ITS OWN duplicate
 *                                 guards (e.g. bsc-next.js's title-collision
 *                                 check) and launch anyway. Accepted but never
 *                                 consulted before the reclaim check below —
 *                                 force means "I've confirmed the orphan is
 *                                 dead", never "skip checking whether it's
 *                                 alive" (card #1706 suggested approach).
 *                                 It DOES bypass the terminal-capacity
 *                                 preflight (task #1904): that gate refuses
 *                                 on a LEARNED number, and a learned number
 *                                 has to stay disprovable by a human who
 *                                 decides to launch anyway. The launch then
 *                                 either succeeds — which raises the ceiling
 *                                 — or fails and confirms it. Bypassing a
 *                                 capacity estimate is not the same class of
 *                                 act as bypassing a liveness check, which is
 *                                 why one is forceable and the other is not.
 * @returns {{ok: boolean, ref?: string, adoptedLate?: boolean, reclaimedAcrossInvocation?: boolean, state?: string, reason?: string, wrapperAlive?: boolean, deadConfirmed?: boolean, workspaceRef?: string|null, seedFile: string|null, command: string|null}}
 *   seedFile/command are null only for the argument-validation refusals
 *   (BRO-2251) — those return before either is computed, since no seed/cmd
 *   file is ever written for a call that fails validation.
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

function launchCmuxSessionInner({ title, seed, seedKey, cwd, model = 'sonnet', focus = true, autoColor = false, settingsPath = null, commandOverride = null, verifyTimeoutSec = 30, lateAdoptSec = 0, slowBootCapSec = DEFAULT_SLOW_BOOT_CAP_SEC, skipAuthPreflight = false, workKey = null, force = false, journalPath = LAUNCH_JOURNAL_PATH, probes = {} }, wakeState = { woke: false }) {
  // force is deliberately NOT consulted by the reclaim check below — see the
  // @param note. Its one effect is bypassing the terminal-capacity preflight
  // (task #1904); everything between here and there behaves identically with
  // or without it, which is what the reclaim tests assert.

  // Fail fast on a malformed call (BRO-2251) — before writing anything or
  // creating a workspace. See describeLaunchArgError's header for the exact
  // incident this closes.
  const argError = describeLaunchArgError({ seed, seedKey, cwd });
  if (argError) {
    const reason = `launchCmuxSession: ${argError} — refusing to create a workspace`;
    console.error(`[cmux-launch] REFUSING launch "${title}": ${reason}`);
    return { ok: false, reason, seedFile: null, command: null };
  }
  // cwd must exist ON DISK, not just be a non-empty string — the reproducing
  // incident's cwd (a stringified-undefined path segment) passed a bare
  // isUsableString check but does not exist, and that is exactly the state
  // that left a pty with nowhere to open a shell. Probe seam matches the
  // cmuxExists() pattern just below.
  const cwdIsDir = probes.cwdIsDir || (p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  if (!cwdIsDir(cwd)) {
    const reason = `launchCmuxSession: cwd does not exist or is not a directory: ${JSON.stringify(cwd)} — refusing to create a workspace`;
    console.error(`[cmux-launch] REFUSING launch "${title}": ${reason}`);
    return { ok: false, reason, seedFile: null, command: null };
  }

  const effectiveWorkKey = String(workKey || seedKey);
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
  // Started-marker file (card #1812): touched as the wrapper's literal FIRST
  // action, before the real command, so waitForLaunchOutcome's startedProbe
  // can learn injection happened even for a wrapper too short-lived for `ps`
  // sampling to ever catch alive — see that function's header for the live
  // repro. Nonce-shared with cmdFile so it's unique per launch attempt exactly
  // like cmdMarker (never a stale hit from an earlier attempt on the same
  // seedKey).
  const startedFile = path.join(os.tmpdir(), `bsc-started-${seedKey}-${launchNonce}`);
  // Quoted (gpt-5.4-mini ship-check catch, 2026-08-19): seedKey can contain
  // characters unsafe for an unquoted shell word (e.g. Linear-mirrored task
  // ids like "linear:BRO-406"); the pre-existing cmdFile/cmdMarker naming
  // shares the same seedKey-in-a-path assumption, but this line puts it
  // INSIDE an executed shell command, not just a filename passed as an argv
  // element, so an unquoted space would break the wrapper script itself.
  fs.writeFileSync(cmdFile, `#!/bin/bash\ntouch "${startedFile}"\n${command}\n`);
  const typed = ` bash ${cmdFile}`; // leading space additionally survives a swallowed first key
  const cmuxExists = probes.cmuxExists || (() => fs.existsSync(CMUX));
  if (!cmuxExists()) return { ok: false, reason: 'cmux CLI not found', seedFile, command };

  // Cross-invocation reclaim (task #1706) — BEFORE anything else, including
  // the auth preflight below: if a PRIOR, SEPARATE launchCmuxSession() call
  // for this same work failed verification but left a workspace that is now
  // demonstrably alive, adopt it instead of opening a second real session.
  // strictlyAliveWorkspace (or probes.strictlyAlive — same test seam pattern
  // as the wrapperAlive/claudeTagAlive probes waitForLaunchOutcome already
  // uses for this exact class of OS-liveness check) is the same fail-closed,
  // both-signals-required probe the in-call lateAdoptSec watch trusts (a
  // listed workspace ref AND cmux's claude tag AND a live OS process for that
  // launch's exact marker) — a transient socket error or a stale registry
  // entry reads as "not alive", never as license to adopt a corpse.
  const strictlyAlive = probes.strictlyAlive || ((ref, marker) => strictlyAliveWorkspace(ref, marker, probes));
  const journalEntry = readLaunchJournalEntry(effectiveWorkKey, journalPath);
  if (journalEntry && strictlyAlive(journalEntry.workspaceRef, journalEntry.marker)) {
    console.error(`[cmux-launch] reclaiming ${journalEntry.workspaceRef} for "${effectiveWorkKey}" — a prior launch (${journalEntry.state || 'unverified'}, recorded ${journalEntry.timestamp}) is now confirmed alive; not opening a second session`);
    // Resolved — a live reclaim is no longer an outstanding failure to track.
    // Leaving the entry would just mean the next call re-verifies liveness
    // again (harmless), but clearing keeps the journal's contents meaning
    // exactly "unresolved failures", matching the dead-orphan clear below.
    clearLaunchJournalEntry(effectiveWorkKey, journalPath);
    if (autoColor) setAutoColor(journalEntry.workspaceRef);
    // The workspace the PRIOR invocation gave up on is demonstrably alive, so
    // it did get a terminal after all. If that invocation recorded a
    // 'runtime-missing' observation, this is its disproof — and the count that
    // matters is the one from THAT invocation (journaled with the entry), not
    // whatever cmux happens to be carrying now. Without this the learning is
    // one-directional: a false low observation persists while the evidence
    // against it never does (/code-review finding 3). Entries written before
    // this field existed carry no count and no-op on the isInteger guard.
    recordCapacityOutcome(journalEntry.liveRuntimes, 'runtime-created', probes);
    return {
      ok: true, ref: journalEntry.workspaceRef, adoptedLate: true, reclaimedAcrossInvocation: true,
      // The PRIOR invocation's marker, never this call's cmdMarker (BRO-2575):
      // the wrapper actually running in the workspace being adopted is the one
      // that launch wrote, and this call's cmdFile is never executed on the
      // reclaim path. Journaling cmdMarker here would give the ledger a marker
      // no process will ever carry, so every later sweep would read the
      // workspace as wrapper-dead — worse than no marker at all.
      marker: journalEntry.marker || null,
      // Finding 9: the count from the invocation that actually CREATED this
      // workspace — the honest value for a ledger row correlating deaths
      // against live-runtime pressure. Omitting it biased the correlation
      // toward clean fast launches, the population least likely to show the
      // effect.
      liveRuntimes: Number.isInteger(journalEntry.liveRuntimes) ? journalEntry.liveRuntimes : null,
      seedFile, command,
    };
  }
  if (journalEntry) clearLaunchJournalEntry(effectiveWorkKey, journalPath); // recorded failure is now confirmed dead (or unreachable) — stop tracking it

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

  // Terminal-runtime capacity preflight (task #1904, root-caused live
  // 2026-08-26). Deliberately here, beside the auth preflight, and NOT in
  // bsc-next/linear-next: this is the one chokepoint every cmux dispatch
  // already funnels through (both CLIs, the opening-night monitor launcher,
  // and probe-cmux-launch.js), and duplicating a guard into two CLIs is the
  // divergence linear-next.js's own header calls out.
  //
  // Past cmux's terminal-runtime ceiling, `new-workspace` still SUCCEEDS and
  // still accepts --command — it just never attaches a terminal, so the
  // command can never run. Creating the workspace anyway is pure waste: it
  // burns a dead-attempt against the task, leaves a corpse tab, and (before
  // this) spent up to four minutes discovering it. Refusing costs one ~100ms
  // read-only probe and creates nothing, so failedLaunchEntries() writes
  // nothing either (it returns [] with no workspaceRef).
  //
  // Fails OPEN in every uncertain case (see cmux-terminal-capacity.js) and
  // carries the same kill-switch convention as the auth preflight above.
  // try/catch even though every path inside probeTerminalCapacity already
  // swallows (ship-check catch): this module's whole contract is that a
  // capacity reading can never block a dispatch, and an uncaught throw here
  // would fail the launch outright — the one outcome the fail-open design
  // exists to rule out. The catch reports "unknown", which is exactly what a
  // missing cmux reports.
  let capacity;
  try {
    capacity = (probes.terminalCapacity || terminalCapacity.probeTerminalCapacity)();
  } catch (e) {
    console.error(`[cmux-launch] WARN terminal-capacity probe threw (${e.message}) — treating capacity as unknown and launching anyway`);
    capacity = { hasCapacity: true, known: false, liveRuntimes: null, ceiling: null, reason: 'probe threw' };
  }
  if (process.env.CMUX_CAPACITY_PREFLIGHT_DISABLED !== '1' && capacity.hasCapacity === false && !force) {
    console.error(`[cmux-launch] REFUSING launch "${title}": ${capacity.reason}`);
    return {
      ok: false,
      reason: capacity.reason,
      // refusedForCapacity means exactly "nothing was created" and NOTHING
      // else. It is deliberately a different field from the post-create
      // terminalRuntimeMissing below (adversarial review blocker): both mean
      // "cmux is out of terminals", but only this one is safe to report as
      // "nothing was created" and journal with a null ref. Conflating them
      // made a real ghost tab get logged as a refusal and lose its
      // attribution entirely.
      refusedForCapacity: true,
      liveRuntimes: capacity.liveRuntimes,
      terminalCeiling: capacity.ceiling,
      // No workspace was created, so there is nothing to journal a death
      // against and nothing to adopt later.
      workspaceRef: null,
      seedFile, command,
    };
  }
  // The count that DECIDES the outcome is the one from before this launch's
  // own workspace exists — comparing a post-create count would include this
  // launch's runtime on the success path and not on the failure path.
  const liveRuntimesBefore = capacity.liveRuntimes;

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
    const r = (probes.newWorkspace || (args => spawnSync(CMUX, args, { encoding: 'utf8' })))(
      ['new-workspace', '--name', title, '--cwd', cwd, '--command', typed, '--focus', String(focus)]);
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
      injectionGraceSec: verifyTimeoutSec, slowBootCapSec, startedFile, probes,
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
      // Card #1829 — second-opinion review flagged that this is the path
      // MOST launches actually take (attempt 1, first-try registration), so
      // it needed the same fix as the late-adopt/reclaim paths below, not
      // just those. claudeRegistered (wrapperAlive && tagAlive) is exactly
      // the two-signal desync this file's own header already documents as
      // unsafe alone (#548: workspace:115 had a live wrapper AND a live cmux
      // tag while read-screen reported the surface gone). One read-screen
      // call here — not per-poll — confirms the surface actually exists
      // before ever reporting success. defaultSurfaceAliveFn, NOT
      // terminalSurfaceAliveIn: the moment wrapper+tag just registered is
      // exactly when the claude UI may not have painted its status-bar
      // chrome yet, and terminalSurfaceAliveIn requires that chrome — using
      // it here would false-fail a brand-new, genuinely healthy launch on
      // pure timing (adversarial review, 2026-08-19).
      const surfaceAliveFn = probes.terminalSurfaceAlive || defaultSurfaceAliveFn;
      if (surfaceAliveFn(ws.ref) !== false) {
        if (autoColor) setAutoColor(ws.ref);
        // cmux DID attach a terminal at this live-runtime count, which is the
        // only evidence that can raise a ceiling learned too low (task #1904).
        recordCapacityOutcome(liveRuntimesBefore, 'runtime-created', probes);
        // marker (BRO-2575): the caller journals this on the ledger's `launch`
        // row so a LATER bsc-prune sweep can re-run osProcessAliveForSeed()
        // against this launch's own wrapper — the only liveness signal that is
        // not read through cmux, and therefore the only one that survives cmux
        // going silent fleet-wide. See dispatch-ledger.deadBreadcrumbs().
        return { ok: true, ref: ws.ref, state: outcome.state, liveRuntimes: liveRuntimesBefore, seedFile, command, marker: cmdMarker };
      }
      // Confirmed dead by the one authoritative signal that disagrees with
      // wrapper+tag. Do NOT close it here — that is the same owner-approved
      // "never close from this function" boundary the 'retry' branch below
      // documents; just refuse to call it a success and fall through to the
      // same failed/late-adopt handling every other unverified outcome gets
      // (which itself now also requires the surface signal, so it will not
      // be silently re-adopted either).
      console.error(`[cmux-launch] ${ws.ref}: wrapper + cmux tag both registered, but read-screen confirms NO terminal surface — refusing to report success (card #1829).`);
      outcome = { ...outcome, action: 'fail', state: STATES.SURFACE_NOT_FOUND, reason: REASONS[STATES.SURFACE_NOT_FOUND] };
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
      //
      // Card #1829 does NOT reopen this (owner-approved Option A stands —
      // closeWorkspace must never reappear here, enforced by
      // dispatch-ledger.test.mjs). The actual fix for "7/7 dead dispatches
      // reported success" lives in strictlyAliveWorkspace below: it now
      // requires cmux's read-screen to independently confirm a live terminal
      // surface before EITHER the in-call late-adopt watch or the
      // cross-invocation reclaim journal can report this workspace ok:true.
      // A workspace left here that never gets a real surface is therefore
      // correctly reported FAILED (not silently adopted), and the NEXT
      // dispatch attempt for the same work — which checks that same journal
      // entry before creating anything — no longer wrongly adopts the corpse
      // and opens a genuinely new workspace instead.
      // BRO-2251: "leaving it for late-adopt" is only true when the caller
      // actually configured lateAdoptSec — with the default of 0 there is no
      // watch, and this call returns the dead-tab verdict as soon as this
      // function exits. Wording it unconditionally as "leaving it for
      // late-adopt" reads as "probably fine, wait and see" even in the common
      // case where nothing further will check on this workspace — the exact
      // false-reassurance this card flagged. State the actual disposition.
      const nextStep = lateAdoptSec > 0
        ? `watching it for a further ${lateAdoptSec}s before reporting it dead (lateAdoptSec set)`
        : 'reporting it dead now (no lateAdoptSec watch configured) — this workspace has NOTHING running in it';
      console.error(`[cmux-launch] attempt ${attempt} reported ${outcome.state} for ${ws ? ws.ref : 'nothing'} — the wrapper-process probe can miss a real process (see scripts/probe-cmux-launch.js), so this function will NOT close or relaunch over a possibly-live tab; ${nextStep}.`);
      break;
    }
    break; // 'fail' — keep survivingWs for the caller (and the late-adopt watch)
  }
  const slowBoot = isSlowBootFailure(outcome && outcome.state);
  const noTerminal = (outcome && outcome.state) === STATES.TERMINAL_RUNTIME_MISSING;
  // Learn the ceiling from the one verdict that proves it (task #1904). This
  // is the bootstrap: the FIRST dispatch to hit the cap pays for the whole
  // fleet, because the preflight above then refuses every subsequent one
  // instead of opening another workspace that can never run its command.
  if (noTerminal) recordCapacityOutcome(liveRuntimesBefore, 'runtime-missing', probes);
  const failed = {
    ok: false,
    state: (outcome && outcome.state) || STATES.INJECTION_NEVER_RAN,
    // NOT refusedForCapacity: a workspace WAS created here and is still open.
    // It is a corpse that needs journaling and attribution, not a launch that
    // never happened.
    terminalRuntimeMissing: noTerminal || undefined,
    liveRuntimes: liveRuntimesBefore,
    // Distinct reasons, so callers and logs stop reporting every slow launch
    // as "cmux is dead" (card #705: that conflation is what made the owner
    // see "cmux breaks at least once a day").
    reason: `${(outcome && outcome.reason) || 'launch not verified'} in ${survivingWs ? survivingWs.ref : 'the new workspace'}`,
    // The wrapper is still running for a slow-boot failure: the workspace is
    // NOT a corpse, must not be closed, and must not be journaled as a death.
    wrapperAlive: !!(outcome && outcome.wrapperAlive),
    deadConfirmed: !slowBoot,
    // BRO-2575: carried on FAILURE too, not just success. The deadConfirmed
    // =false (slow-boot) case is precisely "the wrapper is still running" —
    // exactly what a later sweep's wrapper cross-check needs in order not to
    // bury a session that was merely slow to verify.
    marker: cmdMarker,
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
    // `strictlyAlive`, not strictlyAliveWorkspace directly: same local the
    // cross-invocation reclaim above already goes through, so the in-call
    // watch is reachable from the same probes.strictlyAlive test seam. The
    // two paths make the identical liveness judgement and had no business
    // reaching it by different routes — the asymmetry is why this branch had
    // no unit coverage.
    const live = pollUntil(() => strictlyAlive(failed.workspaceRef, cmdMarker), lateAdoptSec);
    if (shouldAdoptLateStart(failed, live)) {
      if (autoColor) setAutoColor(failed.workspaceRef);
      // A 'runtime-missing' observation was already persisted above, BEFORE
      // this watch ran. The workspace adopting late disproves it, and without
      // a compensating 'runtime-created' the false low observation would
      // survive while its disproof never did (/code-review finding 3).
      recordCapacityOutcome(liveRuntimesBefore, 'runtime-created', probes);
      return { ok: true, ref: failed.workspaceRef, adoptedLate: true, liveRuntimes: liveRuntimesBefore, seedFile, command, marker: cmdMarker };
    }
  }
  // The in-call grace (if any) is exhausted and the workspace is still
  // unverified. Record it so a LATER, separate launchCmuxSession() call for
  // this same work — the retry the caller's own duplicate-title guard will
  // otherwise wave through once someone reasonably concludes this one is dead
  // — checks the reclaim path above before opening a second session. Recorded
  // even for a deadConfirmed failure: this session's live BRO-343 repro
  // (2026-08-16) showed a workspace registering claude well after
  // INJECTION_NEVER_RAN, so "confirmed dead" here is not proof the workspace
  // stays dead.
  if (failed.workspaceRef) {
    writeLaunchJournalEntry(effectiveWorkKey, {
      workspaceRef: failed.workspaceRef,
      marker: cmdMarker,
      state: failed.state,
      // Carried so a LATER invocation that reclaims this workspace can record
      // the disproof against the count this launch was actually judged at —
      // the reclaim path runs before its own capacity probe, so it has no
      // other way to know it (/code-review finding 3).
      liveRuntimes: Number.isInteger(liveRuntimesBefore) ? liveRuntimesBefore : null,
      timestamp: new Date().toISOString(),
    }, journalPath);
  }
  return failed;
}

module.exports = {
  launchCmuxSession, CMUX, CMUX_APP, pollUntil, sleepSec, setAutoColor, setAppFocus,
  osActivateCmuxApp, strictlyAliveWorkspace, computeStrictAliveness, shouldAdoptLateStart,
  waitForLaunchOutcome,
  hasSeedProcess, osProcessAliveForSeed, makeSeedProcessProbe, verifiedAlive, shouldRefuseForAuth,
  buildLaunchCommand, isUsableString, describeLaunchArgError,
  MAX_ATTEMPTS, PROBE_INTERVAL_SEC, WRAPPER_MISS_STREAK, WAKE_AFTER_SEC,
  REWAKE_INTERVAL_SEC,
  shouldPreWake, cmuxIdleSec, noteLaunchAttempt, IDLE_GATE_SEC, LAST_LAUNCH_MARKER,
  readLaunchJournal, readLaunchJournalEntry, writeLaunchJournalEntry, clearLaunchJournalEntry,
  LAUNCH_JOURNAL_PATH,
};
