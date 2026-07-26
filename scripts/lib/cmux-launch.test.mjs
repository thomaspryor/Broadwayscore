import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasSeedProcess, shouldAdoptLateStart } = require('./cmux-launch.js');

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

test('shouldAdoptLateStart: adopts a failed-verify result whose leftover workspace is now alive', () => {
  const result = { ok: false, workspaceRef: 'workspace:115', reason: 'no running claude' };
  assert.equal(shouldAdoptLateStart(result, true), true);
});

test('shouldAdoptLateStart: refuses when the workspace never came alive, or the launch already succeeded', () => {
  assert.equal(shouldAdoptLateStart({ ok: false, workspaceRef: 'workspace:115' }, false), false);
  assert.equal(shouldAdoptLateStart({ ok: true, workspaceRef: 'workspace:115' }, true), false);
  assert.equal(shouldAdoptLateStart({ ok: false, workspaceRef: null }, true), false);
});
