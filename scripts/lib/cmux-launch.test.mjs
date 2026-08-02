import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasSeedProcess, shouldAdoptLateStart, waitForLaunchOutcome } = require('./cmux-launch.js');
const { STATES } = require('./cmux-launch-state.js');

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
  assert.equal(res.state, STATES.INJECTION_NEVER_RAN);
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
