#!/usr/bin/env node
/**
 * Reproduce the dispatch false-negative on demand.
 *
 * WHY THIS EXISTS: ~20 sessions "fixed" the dispatch-death bug and it kept
 * coming back, because nobody could reproduce it — every attempt drove
 * `cmux new-workspace` directly, which always succeeds. The failure lives in
 * launchCmuxSession's WRAPPER-PROCESS PROBE, not in cmux and not in the app's
 * foreground state (that theory was tested and disproved 2026-08-13: hiding
 * the app at the window-server level and clearing set-app-focus still started
 * the command in ~1s).
 *
 * MEASURED 2026-08-13, two runs, both reproduced:
 *   payload `touch M`            -> ok:false injection-never-ran, marker EXISTS
 *   payload `touch M; sleep 180` -> attempt 1 injection-never-ran (workspace
 *                                  CLOSED + relaunched), attempt 2 then logged
 *                                  "command is RUNNING (wrapper process alive)"
 * Same code, same machine, opposite verdicts seconds apart => the 7s probe
 * misses wrappers that exist, and the launcher DESTROYS the workspace on that
 * false verdict. That is how healthy sessions die.
 *
 * Exit 1 == launcher verdict and ground truth disagree == bug reproduced.
 * Use this as the acceptance test for any launcher change: it must go from
 * exit 1 to exit 0, and a deliberately-broken command must still exit 0 by
 * correctly reporting dead.
 *
 * Exercise the REAL launch path (launchCmuxSession), not raw `cmux new-workspace`.
 *
 * Every repro so far drove cmux directly and always succeeded in ~1s. The real
 * dispatcher does more: auth preflight, a --settings deny-list file, model
 * flags, and a TYPED bash wrapper written to a cmd file. The "no wrapper
 * process appeared" verdict is about that wrapper, so the failure may live in
 * this layer rather than in cmux's surface rendering.
 *
 * Launches one throwaway session whose command only touches a marker, then
 * reports what launchCmuxSession returned alongside what actually happened on
 * the machine. Those two answers disagreeing IS the bug.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

// Overridable so the probe can exercise a worktree's cmux-launch.js — otherwise
// it would always test main's copy and silently "verify" the wrong code.
const REPO = process.env.PROBE_REPO || '/Users/tompryor/Broadwayscore';
const { launchCmuxSession } = require(path.join(REPO, 'scripts/lib/cmux-launch.js'));

const stamp = Date.now();
const marker = path.join(os.tmpdir(), `real-launch-${stamp}`);
const title = `ZZ-probe-${stamp}`;

(async () => {
  const t0 = Date.now();
  let result;
  try {
    result = await launchCmuxSession({
      title,
      seed: 'probe',
      seedKey: `probe-${stamp}`,
      cwd: os.tmpdir(),
      model: 'sonnet',
      focus: true,
      // Replace the claude invocation entirely: we are testing the LAUNCH
      // mechanism, not claude. A bare touch is the cheapest possible payload.
      // Fast-exit payload: reliably triggers the injection-never-ran verdict,
      // which is the branch under test. A long-lived payload sometimes gets
      // detected on attempt 1 and never exercises it.
      commandOverride: `touch ${marker}`,
      verifyTimeoutSec: 45,
      skipAuthPreflight: true,
    });
  } catch (err) {
    result = { threw: String(err && err.message) };
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== launchCmuxSession returned after ${elapsed}s ===`);
  console.log(JSON.stringify(result, null, 1).slice(0, 900));

  // Ground truth, independent of the launcher's own opinion.
  let markerSeen = fs.existsSync(marker);
  if (!markerSeen) {
    // Give it the same grace the real failure had (process appeared 5m25s late).
    console.log('\nmarker absent at return — watching another 60s...');
    for (let i = 0; i < 60 && !markerSeen; i++) {
      spawnSync('sleep', ['1']);
      markerSeen = fs.existsSync(marker);
      if (markerSeen) console.log(`marker appeared ${i + 1}s AFTER launcher returned`);
    }
  }

  console.log('');
  console.log(`launcher verdict : ${result && result.ok ? 'ok:true' : `ok:false (${result && (result.state || result.threw)})`}`);
  console.log(`ground truth     : command ${markerSeen ? 'DID run' : 'did NOT run'}`);
  const disagree = !!(result && result.ok) !== markerSeen;
  console.log(`\n${disagree ? '*** LAUNCHER AND REALITY DISAGREE — bug reproduced ***' : 'launcher and reality agree'}`);

  // Cleanup
  if (result && result.ws && result.ws.ref) {
    spawnSync('/Applications/cmux.app/Contents/Resources/bin/cmux',
      ['close-workspace', '--workspace', result.ws.ref], { timeout: 8000 });
  }
  try { fs.unlinkSync(marker); } catch { /* fine */ }
  process.exit(disagree ? 1 : 0);
})();
