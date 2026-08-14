import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasSeedProcess, shouldAdoptLateStart, waitForLaunchOutcome, osActivateCmuxApp, CMUX_APP, shouldRefuseForAuth,
  shouldPreWake, cmuxIdleSec, noteLaunchAttempt, IDLE_GATE_SEC, buildLaunchCommand } = require('./cmux-launch.js');
const { STATES } = require('./cmux-launch-state.js');

// Task #1438: replaces a source-regex in bsc-next.test.mjs that pinned this
// exact template-literal formatting (would break on a harmless reformat while
// the launched command stayed byte-identical — the #1432/#1434 fragile class).
test('buildLaunchCommand: always carries the resolved model + --dangerously-skip-permissions', () => {
  const cmd = buildLaunchCommand('opus', null, '/tmp/seed.txt');
  assert.match(cmd, /^claude --model opus --dangerously-skip-permissions /);
  assert.ok(cmd.includes('--dangerously-skip-permissions'));
  assert.ok(cmd.includes('$(cat /tmp/seed.txt)'));
});

test('buildLaunchCommand: settingsPath adds --settings, omitted when null', () => {
  const withSettings = buildLaunchCommand('sonnet', '/path/to/deny.json', '/tmp/seed.txt');
  assert.ok(withSettings.includes('--settings /path/to/deny.json'));
  const withoutSettings = buildLaunchCommand('sonnet', null, '/tmp/seed.txt');
  assert.ok(!withoutSettings.includes('--settings'));
});

// Card #856 (Session-system overhaul S3): launcher auth pre-check gate.
test('shouldRefuseForAuth: refuses only on an explicit ok:false result', () => {
  assert.equal(shouldRefuseForAuth({ ok: false, mode: 'fail', detail: 'Not logged in' }), true);
  assert.equal(shouldRefuseForAuth({ ok: true, mode: 'oauth' }), false);
  assert.equal(shouldRefuseForAuth({ ok: true, mode: 'api-key' }), false);
  assert.equal(shouldRefuseForAuth(null), false);
  assert.equal(shouldRefuseForAuth(undefined), false);
});

// Fake clock + probes for the verification wait (card #705). intervalSec 0
// keeps `sleep 0` cheap; `now` advances 5 simulated seconds per poll so a
// 6-minute wait costs milliseconds.
function fakeWait({ wrapperAliveAt = () => false, tagAliveAt = () => false, ...opts }) {
  let t = 0;
  const polls = [];
  const res = waitForLaunchOutcome({
    ws: { ref: 'workspace:900' }, marker: 'bsc-cmd-705-abcd1234.sh',
    attempt: 1, maxAttempts: 2, injectionGraceSec: 90, slowBootCapSec: 360,
    ...opts,
    probes: {
      intervalSec: 0,
      now: () => { const v = t; t += 5000; return v; },
      wrapperAlive: () => { const v = wrapperAliveAt(t / 1000); polls.push({ t: t / 1000, wrapperAlive: v }); return v; },
      claudeTagAlive: () => tagAliveAt(t / 1000),
      // MUST be stubbed: without it the deferred-render wake default fires a
      // REAL `cmux set-app-focus active` on the host with no clear (lazy-exec
      // fix ship-check finding, 2026-08-02).
      wake: () => {},
    },
  });
  return { res, polls };
}

// Captured shape from `ps -e -ww -o command=` on the host, 2026-07-26 — the
// bash wrapper stays alive as the foreground claude process's parent for the
// whole session (card #548). Markers are nonce-suffixed cmd-file basenames —
// seedKey alone (task.id) is NOT unique across dispatch attempts of the same
// task, so the launcher matches on the full basename, not the bare seedKey.
const PS_SAMPLE = `/sbin/launchd
bash /var/folders/__/n5f8n1yj2wnch4lpmz1138840000gn/T/bsc-cmd-545-a1b2c3d4.sh
/Users/tompryor/.local/bin/claude --session-id abc --model sonnet --dangerously-skip-permissions [#545] Retrofit hasHelpFlag —
bash /var/folders/__/n5f8n1yj2wnch4lpmz1138840000gn/T/bsc-cmd-548-e5f6a7b8.sh
/Users/tompryor/.local/bin/claude --session-id def --model opus --dangerously-skip-permissions [#548] bsc-next false verified running —
grep -i bsc-cmd
`;

test('hasSeedProcess: finds the bash wrapper for a live launch marker', () => {
  assert.equal(hasSeedProcess(PS_SAMPLE, 'bsc-cmd-545-a1b2c3d4.sh'), true);
  assert.equal(hasSeedProcess(PS_SAMPLE, 'bsc-cmd-548-e5f6a7b8.sh'), true);
});

test('hasSeedProcess: false for a marker with no matching wrapper (the #548 false-positive case)', () => {
  // workspace:115's real bug: cmux's own tag said alive, but no OS process
  // existed for #545's second attempt — this is what that looks like.
  assert.equal(hasSeedProcess(PS_SAMPLE, 'bsc-cmd-545-deadbeef.sh'), false);
  assert.equal(hasSeedProcess(PS_SAMPLE, 'bsc-cmd-999-a1b2c3d4.sh'), false);
});

test('hasSeedProcess: a STALE wrapper from an earlier attempt on the same task does not match a different attempt\'s marker', () => {
  // The exact bug an adversarial review caught pre-ship: seedKey (task.id)
  // repeats across dispatch attempts, so two concurrently-live bash wrappers
  // for task #545 existed on the host from separate attempts. Matching on
  // the bare seedKey would let attempt A's leftover process confirm attempt
  // B's workspace. The nonce-suffixed marker must not conflate them.
  const staleAttempt = `bash /tmp/bsc-cmd-545-oldnonce1.sh\n`;
  assert.equal(hasSeedProcess(staleAttempt, 'bsc-cmd-545-newnonce2.sh'), false);
});

test('hasSeedProcess: empty/garbage ps output is never a false positive', () => {
  assert.equal(hasSeedProcess('', 'bsc-cmd-545-a1b2c3d4.sh'), false);
  assert.equal(hasSeedProcess('not a process list', 'bsc-cmd-545-a1b2c3d4.sh'), false);
});

test('waitForLaunchOutcome: a slow boot NEVER asks for a retry while the wrapper lives (card #705)', () => {
  // The reproduced incident: the typed command starts at ~40s, claude
  // registers at ~4.5 min. The old fixed window declared this dead at 90s and
  // relaunched — three identical crowned sessions on 2026-07-31.
  const { res, polls } = fakeWait({
    wrapperAliveAt: t => t >= 40,
    tagAliveAt: t => t >= 270,
  });
  assert.equal(res.action, 'ok');
  assert.equal(res.state, STATES.REGISTERED);
  assert.ok(polls.some(p => p.t > 90 && p.wrapperAlive), 'must have kept polling past the old 90s window');
});

test('waitForLaunchOutcome: wrapper alive but claude never registers → slow-boot-timeout, still not a retry', () => {
  const { res } = fakeWait({ wrapperAliveAt: t => t >= 10 });
  assert.equal(res.action, 'fail', 'a live wrapper must never yield action:retry — that relaunch is the duplicate factory');
  assert.equal(res.state, STATES.SLOW_BOOT_TIMEOUT);
  assert.equal(res.wrapperAlive, true, 'callers use this to know the workspace is NOT a corpse');
  assert.ok(res.elapsedSec >= 360);
});

test('waitForLaunchOutcome: nothing ever runs → injection-never-ran, retry allowed', () => {
  const { res } = fakeWait({});
  assert.equal(res.action, 'retry');
  assert.equal(res.state, STATES.INJECTION_NEVER_RAN);
  assert.equal(res.wrapperAlive, false);
  assert.ok(res.elapsedSec >= 90 && res.elapsedSec < 360, 'must give up on a never-started command in the grace window, not the slow-boot cap');

  // Last attempt: same state, terminal.
  const last = fakeWait({ attempt: 2 }).res;
  assert.equal(last.action, 'fail');
  assert.equal(last.state, STATES.INJECTION_NEVER_RAN);
});

test('waitForLaunchOutcome: claude tag alone never verifies without a live wrapper process (#548 cross-check intact)', () => {
  const { res } = fakeWait({ wrapperAliveAt: () => false, tagAliveAt: () => true });
  assert.notEqual(res.action, 'ok', 'cmux tag registry can desync — the OS process is ground truth');
  // …but it also must not retry into a workspace cmux says is live: unverified,
  // not dead (ship-check hardening).
  assert.equal(res.action, 'fail');
  assert.equal(res.state, STATES.WRAPPER_GONE_TAG_ALIVE);
});

test('waitForLaunchOutcome: ONE flaky ps sample never closes a live launch (probe fails closed)', () => {
  // osProcessAliveForSeed returns false on any ps error/timeout/truncation.
  // Without debouncing, that single miss reads as "the wrapper died" and the
  // launcher closes and relaunches a healthy session.
  let polls = 0;
  const { res } = fakeWait({
    wrapperAliveAt: () => { polls += 1; return polls !== 3; }, // one bad sample mid-flight
    tagAliveAt: t => t >= 120,
  });
  assert.equal(res.action, 'ok', 'a single missed sample must not end the wait');
});

test('waitForLaunchOutcome: a REAL wrapper exit (sustained misses) still ends the wait', () => {
  // The debounce must not make a genuine death undetectable.
  const { res } = fakeWait({ wrapperAliveAt: t => t < 30 });
  assert.equal(res.state, STATES.WRAPPER_EXITED);
  assert.equal(res.action, 'retry');
});

test('waitForLaunchOutcome: the boot budget starts when the wrapper appears, not at workspace creation', () => {
  // Injection lands at 60s (inside the 90s grace); claude registers at 400s.
  // Total elapsed then exceeds the 360s cap, but the BOOT only took ~340s —
  // measuring the cap from workspace creation would kill this healthy launch.
  const { res } = fakeWait({
    wrapperAliveAt: t => t >= 60,
    tagAliveAt: t => t >= 400,
  });
  assert.equal(res.action, 'ok');
  assert.ok(res.elapsedSec >= 360, 'total elapsed exceeded the slow-boot cap, yet the launch verified');
});

test('shouldAdoptLateStart: adopts a failed-verify result whose leftover workspace is now alive', () => {
  const result = { ok: false, workspaceRef: 'workspace:115', reason: 'no running claude' };
  assert.equal(shouldAdoptLateStart(result, true), true);
});

test('shouldAdoptLateStart: refuses when the workspace never came alive, or the launch already succeeded', () => {
  assert.equal(shouldAdoptLateStart({ ok: false, workspaceRef: 'workspace:115' }, false), false);
  assert.equal(shouldAdoptLateStart({ ok: true, workspaceRef: 'workspace:115' }, true), false);
  assert.equal(shouldAdoptLateStart({ ok: false, workspaceRef: null }, true), false);
});

test('osActivateCmuxApp: best-effort OS-level activation, never throws (card #900)', () => {
  // set-app-focus (the existing wake) is an IPC call INTO cmux's own socket
  // handler — it never touches the real macOS window server, which is the
  // gap this function closes (six cross-task INJECTION_NEVER_RAN failures
  // in the two hours after the 8/3 restart despite the IPC flag firing on
  // every one of them). `open -a` asks the OS itself to activate the app,
  // which reaches states set-app-focus cannot. Must be silent/non-throwing
  // even when `open` or the app bundle is unavailable (CI has no GUI).
  assert.doesNotThrow(() => osActivateCmuxApp());
  assert.equal(CMUX_APP, '/Applications/cmux.app');
});

test('waitForLaunchOutcome: wake() sees isFirstWake=true only on the FIRST call, false on rewakes (Codex P1, 2026-08-03)', () => {
  // osActivateCmuxApp (real OS foreground) is gated on !isFirstWake — firing
  // it on every 5s-delayed launch would steal screen focus for the common
  // brief-lag case, not just a genuine outage. Pin the sequence the caller
  // (launchCmuxSessionInner) relies on to make that gating correct.
  let t = 0;
  const wakeCalls = [];
  waitForLaunchOutcome({
    ws: { ref: 'workspace:900' }, marker: 'bsc-cmd-705-abcd1234.sh',
    attempt: 1, maxAttempts: 2, injectionGraceSec: 90, slowBootCapSec: 360,
    probes: {
      intervalSec: 0,
      now: () => { const v = t; t += 5000; return v; },
      wrapperAlive: () => false,
      claudeTagAlive: () => false,
      wake: isFirstWake => wakeCalls.push(isFirstWake),
    },
  });
  assert.ok(wakeCalls.length >= 2, 'the never-injects case must rewake more than once inside the grace window');
  assert.equal(wakeCalls[0], true);
  assert.ok(wakeCalls.slice(1).every(v => v === false), 'every call after the first must report isFirstWake=false');
});

// ── Idle-gated pre-wake (card #1199) ───────────────────────────────────────
// Measured over 399 real cmux launches: deaths cluster on launches into an
// IDLE app (>10m gap = 22% dead vs <5s gap = 8%; solo = 19% vs 1-2 concurrent
// siblings = 7%; 00:00-05:00 ET = 31% vs 10:00-11:00 = 0%). The existing wake
// is reactive — it only fires after the surface has already failed to render.

test('shouldPreWake: wakes on a long-idle app, stays out of the way of a busy one', () => {
  assert.equal(shouldPreWake({ idleSec: 600 }), true, '10m idle is the 22%-dead segment');
  assert.equal(shouldPreWake({ idleSec: IDLE_GATE_SEC }), true, 'exactly at the gate wakes');
  assert.equal(shouldPreWake({ idleSec: 3 }), false, 'a launch 3s after another is the 8%-dead segment');
  assert.equal(shouldPreWake({ idleSec: IDLE_GATE_SEC - 1 }), false);
});

// The finally-clear in launchCmuxSession is launch-scoped and NOT refcounted,
// so a concurrent launcher's clear can re-defer a sibling's still-unrendered
// surface. Waking on EVERY launch would make that rare collision the common
// case, and precisely in the regime the data says is already safest. The gate
// is what keeps `woke` correlated with genuinely-idle launches.
test('shouldPreWake: a concurrent batch does NOT wake, so the unrefcounted clear stays rare', () => {
  const busy = [0, 1, 5, 30, 119].map(idleSec => shouldPreWake({ idleSec }));
  assert.deepEqual(busy, [false, false, false, false, false]);
});

test('shouldPreWake: an unknown idle reading always wakes — the cheap flag is the safe answer', () => {
  assert.equal(shouldPreWake({ idleSec: Infinity }), true, 'no marker = first launch since boot');
  assert.equal(shouldPreWake({ idleSec: NaN }), true);
  assert.equal(shouldPreWake({ idleSec: undefined }), true);
  assert.equal(shouldPreWake({ idleSec: -50 }), true, 'marker stamped in the future by a clock step');
});

test('shouldPreWake: attempt 2 always wakes — a retry only happens after nothing ran', () => {
  assert.equal(shouldPreWake({ idleSec: 0, attempt: 2 }), true);
  assert.equal(shouldPreWake({ idleSec: 0, attempt: 1 }), false);
});

test('cmuxIdleSec/noteLaunchAttempt: real marker round-trip, and Infinity when absent', () => {
  const marker = path.join(os.tmpdir(), `bsc-cmux-last-launch-test-${process.pid}`);
  try { fs.unlinkSync(marker); } catch { /* fresh */ }
  assert.equal(cmuxIdleSec(marker), Infinity, 'a missing marker must read as idle, not 0');
  assert.equal(shouldPreWake({ idleSec: cmuxIdleSec(marker) }), true);

  noteLaunchAttempt(marker);
  const idle = cmuxIdleSec(marker);
  assert.ok(idle >= 0 && idle < 5, `a just-stamped marker must read as busy, got ${idle}`);
  assert.equal(shouldPreWake({ idleSec: idle }), false, 'a sibling launcher one second later must skip its own pre-wake');

  // 10 minutes ago → back over the gate.
  const old = Date.now() - 600_000;
  fs.utimesSync(marker, new Date(old), new Date(old));
  assert.ok(cmuxIdleSec(marker) > IDLE_GATE_SEC);
  assert.equal(shouldPreWake({ idleSec: cmuxIdleSec(marker) }), true);
  fs.unlinkSync(marker);
});

test('cmuxIdleSec: sub-ms negative jitter clamps to 0, a real clock step reads as unknown', () => {
  // Date.now() is ms-resolution, mtimeMs carries the filesystem's finer clock,
  // so a marker stamped microseconds ago legitimately reads slightly negative.
  // Unclamped, shouldPreWake's "negative = unknown = wake" rule would fire on
  // a marker a concurrent launcher had JUST stamped — which is exactly the
  // collision the idle gate exists to avoid. Found by this file's own
  // round-trip test failing at -0.0005s.
  const marker = path.join(os.tmpdir(), `bsc-cmux-jitter-test-${process.pid}`);
  noteLaunchAttempt(marker);
  const st = fs.statSync(marker);
  assert.equal(cmuxIdleSec(marker, st.mtimeMs - 0.5), 0, 'half a millisecond in the future is jitter');
  assert.equal(shouldPreWake({ idleSec: cmuxIdleSec(marker, st.mtimeMs - 0.5) }), false);
  assert.equal(cmuxIdleSec(marker, st.mtimeMs - 60_000), Infinity, 'a minute in the future is a clock step, not jitter');
  assert.equal(shouldPreWake({ idleSec: cmuxIdleSec(marker, st.mtimeMs - 60_000) }), true);
  fs.unlinkSync(marker);
});
