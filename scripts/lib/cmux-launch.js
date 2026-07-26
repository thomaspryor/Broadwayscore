/**
 * cmux-launch — shared "open a cmux workspace already running Claude Code"
 * primitive. Extracted from bsc-next.js launchCmux() (2026-07-24) so non-task
 * callers (opening-night monitor launcher) get the same verified launch
 * mechanics without fabricating a fake task object: seed/cmd wrapper files
 * (shell-init race, 2026-07-12), two launch attempts, a 30s claudeAliveIn
 * verification window (a mangled command never starts claude and nothing else
 * would notice), and the Blue auto-dispatch tab color.
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

const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';

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

// A launch result is adoptable when it FAILED verification but left a real
// workspace behind that is now demonstrably alive — i.e. claude registered
// after the verify window, not never.
function shouldAdoptLateStart(result, isAlive) {
  return !!(result && !result.ok && result.workspaceRef && isAlive);
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
 * @param {number}  [opts.verifyTimeoutSec] seconds to wait for a live claude
 *                                 process before declaring the launch dead.
 *                                 Default 30 (sonnet cold start). Fable +
 *                                 heavy session-start hooks need ~60-90s —
 *                                 the first live monitor launch (2026-07-24)
 *                                 came alive AFTER the 30s window, got its
 *                                 workspace close-and-retried, and left an
 *                                 untracked live session behind.
 * @param {number}  [opts.lateAdoptSec] seconds to keep watching a FAILED
 *                                 launch's leftover workspace before calling
 *                                 it dead. A claude that registers here is
 *                                 healthy-but-slow, not a corpse: adopt it
 *                                 (ok:true, adoptedLate:true) instead of
 *                                 reporting a false failure the caller then
 *                                 "fixes" by dispatching a duplicate.
 *                                 0 = off (legacy behavior).
 * @returns {{ok: boolean, ref?: string, adoptedLate?: boolean, reason?: string, workspaceRef?: string|null, seedFile: string, command: string}}
 */
function launchCmuxSession({ title, seed, seedKey, cwd, model = 'sonnet', focus = true, autoColor = false, settingsPath = null, commandOverride = null, verifyTimeoutSec = 30, lateAdoptSec = 0 }) {
  const seedFile = path.join(os.tmpdir(), `bsc-seed-${seedKey}.txt`);
  fs.writeFileSync(seedFile, seed);
  // The wrapper script expands $(cat …) so the multi-line prompt survives
  // without brittle inline quoting. `claude "<prompt>"` opens interactive on it.
  // --dangerously-skip-permissions: launched sessions must never permission-ping
  // (user rule 2026-07-12); explicit permissions.deny rules still outrank bypass.
  const settingsArg = settingsPath ? ` --settings ${settingsPath}` : '';
  const command = commandOverride || `claude --model ${model}${settingsArg} --dangerously-skip-permissions "$(cat ${seedFile})"`;
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
  for (let attempt = 1; attempt <= 2; attempt++) {
    survivingWs = null;
    const before = new Set(cmuxws.listWorkspaces().map(w => w.ref));
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
    if (ws) console.error(`[cmux-launch] ${ws.ref} created — waiting up to ${verifyTimeoutSec}s for claude to register (attempt ${attempt}/2)`);
    // VERIFY the launch (scope add 3): a workspace whose command was mangled
    // never starts claude and never self-marks ✅, so nothing would notice.
    // Poll for a LIVE claude_code process (any status — a fast launch can
    // reach waiting-at-prompt inside the window, and the Running-only check
    // would kill that healthy session as a corpse; ship-check 2026-07-21).
    // Window: shell init (direnv) + claude cold start can exceed 15s
    // post-reboot, and a false timeout kills a healthy launch (2026-07-12).
    if (ws && pollUntil(() => verifiedAlive(ws, cmdMarker), verifyTimeoutSec)) {
      if (autoColor) setAutoColor(ws.ref);
      return { ok: true, ref: ws.ref, seedFile, command };
    }
    if (attempt === 1) {
      // Verify-before-close: one last check after a beat, so a claude that
      // registered at the buzzer isn't killed as a corpse.
      sleepSec(2);
      if (verifiedAlive(ws, cmdMarker)) {
        if (autoColor) setAutoColor(ws.ref);
        return { ok: true, ref: ws.ref, seedFile, command };
      }
      if (ws) { try { cmuxws.closeWorkspace(ws.ref); } catch { /* already gone */ } }
      survivingWs = null; // closed above — must never be adopted or journaled
      sleepSec(2);
    }
  }
  const failed = {
    ok: false,
    reason: `no running claude in ${survivingWs ? survivingWs.ref : 'the new workspace'} after 2 attempts`,
    workspaceRef: survivingWs ? survivingWs.ref : null,
    seedFile, command,
  };

  // Late-start adoption (task #503, generalized from the monitor launcher's
  // 2026-07-24 fix): the attempt-2 workspace is NOT closed above, so a claude
  // that registers a few seconds past the verify window keeps running while
  // the caller is told the launch died. Every such false failure produced an
  // untracked, unjournaled live shell AND a duplicate dispatch onto the same
  // task (10 of them on 2026-07-26). Watch the survivor here instead.
  if (lateAdoptSec > 0 && failed.workspaceRef) {
    console.error(`[cmux-launch] verify window expired — watching ${failed.workspaceRef} for a further ${lateAdoptSec}s before calling it dead`);
    const live = pollUntil(() => strictlyAliveWorkspace(failed.workspaceRef, cmdMarker), lateAdoptSec);
    if (shouldAdoptLateStart(failed, live)) {
      if (autoColor) setAutoColor(failed.workspaceRef);
      return { ok: true, ref: failed.workspaceRef, adoptedLate: true, seedFile, command };
    }
  }
  return failed;
}

module.exports = {
  launchCmuxSession, CMUX, pollUntil, sleepSec, setAutoColor,
  strictlyAliveWorkspace, shouldAdoptLateStart,
  hasSeedProcess, osProcessAliveForSeed, verifiedAlive,
};
