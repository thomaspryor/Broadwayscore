import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideLaunchWait, isSlowBootFailure, STATES,
  shouldProbeSurface, shouldReprobeCapacity,
  SURFACE_PROBE_AFTER_SEC, SURFACE_PROBE_INTERVAL_SEC,
  CAPACITY_REPROBE_INTERVAL_SEC, CAPACITY_PROBE_MAX_ATTEMPTS } = require('./cmux-launch-state.js');

// Card #705: three launches on 2026-07-31 00:06-00:35 ET were reported dead by
// a 90s verify window, retried, and ALL came alive minutes later — three
// identical crowned sessions on the same mandate. The decision below is what
// stops that: a live wrapper process means "booting", never "dead".

test('claude registered → ok, regardless of anything else', () => {
  assert.deepEqual(
    decideLaunchWait({ claudeRegistered: true, wrapperAlive: true, elapsedSec: 5 }),
    { action: 'ok', state: STATES.REGISTERED, reason: null });
  // Even past every cap: verified is verified.
  assert.equal(decideLaunchWait({ claudeRegistered: true, wrapperAlive: false, elapsedSec: 9999 }).action, 'ok');
});

test('wrapper alive + no claude → WAIT, never retry (the duplicate factory)', () => {
  for (const elapsedSec of [1, 60, 90, 120, 300, 359]) {
    const d = decideLaunchWait({ wrapperAlive: true, wrapperEverSeen: true, elapsedSec });
    assert.equal(d.action, 'wait', `elapsed ${elapsedSec}s must keep waiting`);
    assert.equal(d.state, STATES.LAUNCHING_SLOW);
  }
  // The live repro: 4-5 minutes to registration under load. The old 90s window
  // called this dead; the new machine is still waiting at 270s.
  assert.equal(decideLaunchWait({ wrapperAlive: true, elapsedSec: 270 }).action, 'wait');
  // …and a retry is never offered while the wrapper lives, even on attempt 1
  // of 2 where a retry would otherwise be allowed.
  assert.notEqual(decideLaunchWait({ wrapperAlive: true, elapsedSec: 300, attempt: 1, maxAttempts: 2 }).action, 'retry');
});

test('wrapper alive at the slow-boot cap → fail as slow-boot-timeout, never retry', () => {
  const d = decideLaunchWait({ wrapperAlive: true, wrapperEverSeen: true, elapsedSec: 360, attempt: 1, maxAttempts: 2 });
  assert.equal(d.action, 'fail');
  assert.equal(d.state, STATES.SLOW_BOOT_TIMEOUT);
  assert.match(d.reason, /still alive/);
  assert.equal(isSlowBootFailure(d.state), true);
});

test('wrapper gone + never seen + past the grace window → injection-never-ran', () => {
  const first = decideLaunchWait({ wrapperAlive: false, wrapperEverSeen: false, elapsedSec: 91, attempt: 1, maxAttempts: 2 });
  assert.equal(first.action, 'retry', 'nothing ever ran — a fresh attempt is the correct move');
  assert.equal(first.state, STATES.INJECTION_NEVER_RAN);

  const last = decideLaunchWait({ wrapperAlive: false, wrapperEverSeen: false, elapsedSec: 91, attempt: 2, maxAttempts: 2 });
  assert.equal(last.action, 'fail');
  assert.equal(last.state, STATES.INJECTION_NEVER_RAN);
  assert.match(last.reason, /injection never ran/);
  assert.equal(isSlowBootFailure(last.state), false);
});

test('wrapper not seen yet but inside the grace window → wait (keystrokes may still be landing)', () => {
  const d = decideLaunchWait({ wrapperAlive: false, wrapperEverSeen: false, elapsedSec: 30 });
  assert.equal(d.action, 'wait');
  assert.equal(d.state, STATES.AWAITING_INJECTION);
});

test('wrapper ran then exited with no claude → wrapper-exited (a real death, retry allowed)', () => {
  const d = decideLaunchWait({ wrapperAlive: false, wrapperEverSeen: true, elapsedSec: 20, attempt: 1, maxAttempts: 2 });
  assert.equal(d.action, 'retry');
  assert.equal(d.state, STATES.WRAPPER_EXITED);
  // Even before the grace window expires: the wrapper's death is proof, not a timeout.
  assert.equal(decideLaunchWait({ wrapperEverSeen: true, elapsedSec: 3, attempt: 2, maxAttempts: 2 }).action, 'fail');
});

test('wrapper gone but cmux still reports a live claude → never retry (ambiguous, leave it alone)', () => {
  // Signals disagree. Believing "dead" closes and relaunches over a possibly
  // real session (the #705 duplicate); believing "alive" only costs an
  // unverified report. The asymmetry decides it.
  const d = decideLaunchWait({ wrapperAlive: false, wrapperEverSeen: true, tagAlive: true, elapsedSec: 30, attempt: 1, maxAttempts: 2 });
  assert.equal(d.action, 'fail');
  assert.equal(d.state, STATES.WRAPPER_GONE_TAG_ALIVE);
  assert.equal(isSlowBootFailure(d.state), true, 'callers must not journal this as a death either');

  // Same veto when the wrapper was never seen at all (a lost ps probe).
  assert.equal(decideLaunchWait({ tagAlive: true, elapsedSec: 500, attempt: 1, maxAttempts: 2 }).state, STATES.WRAPPER_GONE_TAG_ALIVE);
  // …and without the tag, that same state IS a retryable death.
  assert.equal(decideLaunchWait({ wrapperEverSeen: true, tagAlive: false, elapsedSec: 30, attempt: 1, maxAttempts: 2 }).action, 'retry');
});

test('the slow-boot cap is a BOOT budget, measured from the wrapper appearing', () => {
  // Injection landed at 89s of a 90s grace; claude then needs 5 more minutes.
  // Measuring the cap from workspace creation would leave only 271s of 360s
  // and kill a healthy launch (Codex ship-check).
  const late = { wrapperAlive: true, wrapperEverSeen: true, slowBootCapSec: 360 };
  assert.equal(decideLaunchWait({ ...late, elapsedSec: 389, bootElapsedSec: 300 }).action, 'wait');
  assert.equal(decideLaunchWait({ ...late, elapsedSec: 449, bootElapsedSec: 360 }).state, STATES.SLOW_BOOT_TIMEOUT);
  // bootElapsedSec omitted → falls back to elapsedSec (old behavior).
  assert.equal(decideLaunchWait({ ...late, elapsedSec: 400 }).state, STATES.SLOW_BOOT_TIMEOUT);
});

test('caller-supplied windows are honored (bsc-next passes its own)', () => {
  const cfg = { injectionGraceSec: 10, slowBootCapSec: 40 };
  assert.equal(decideLaunchWait({ ...cfg, elapsedSec: 9 }).state, STATES.AWAITING_INJECTION);
  assert.equal(decideLaunchWait({ ...cfg, elapsedSec: 11, attempt: 2, maxAttempts: 2 }).state, STATES.INJECTION_NEVER_RAN);
  assert.equal(decideLaunchWait({ ...cfg, wrapperAlive: true, elapsedSec: 39 }).action, 'wait');
  assert.equal(decideLaunchWait({ ...cfg, wrapperAlive: true, elapsedSec: 40 }).state, STATES.SLOW_BOOT_TIMEOUT);
});

test('garbage/edge inputs never produce a spurious retry', () => {
  // No fields at all: elapsed 0, nothing seen → wait, not retry.
  assert.equal(decideLaunchWait().action, 'wait');
  assert.equal(decideLaunchWait({}).action, 'wait');
  // A NaN clock must not read as "past the cap".
  assert.equal(decideLaunchWait({ elapsedSec: NaN }).action, 'wait');
  assert.equal(decideLaunchWait({ wrapperAlive: true, elapsedSec: NaN }).action, 'wait');
  assert.equal(decideLaunchWait({ elapsedSec: -50 }).action, 'wait');
});

test('the full 2026-07-31 timeline resolves to ONE workspace, adopted late', () => {
  // Replay of the reproduced incident: injection lands at ~40s, claude
  // registers at ~4.5 min. Old behavior: retry at 90s → duplicate. New:
  // continuous wait, then ok.
  const poll = (t, wrapperAlive, claudeRegistered, wrapperEverSeen) =>
    decideLaunchWait({ elapsedSec: t, wrapperAlive, claudeRegistered, wrapperEverSeen, attempt: 1, maxAttempts: 2 });

  const actions = [
    poll(10, false, false, false),   // typing not landed yet
    poll(40, true, false, true),     // wrapper up
    poll(90, true, false, true),     // old verify window expires here
    poll(180, true, false, true),
    poll(269, true, false, true),
    poll(270, true, true, true),     // claude registers at 4.5 min
  ].map(d => d.action);

  assert.deepEqual(actions, ['wait', 'wait', 'wait', 'wait', 'wait', 'ok']);
  assert.equal(actions.includes('retry'), false, 'a retry anywhere in this timeline is a duplicate session');
});

// ── Task #1904: cmux's terminal-runtime ceiling ────────────────────────────
// Root-caused live 2026-08-26. Past ~29 live terminal runtimes cmux still
// creates the workspace and still accepts the --command, but never attaches a
// terminal (debug-terminals: runtime=0 ghostty=nil), so the command can never
// run there. Nothing inside cmux rescues it; only a runtime freeing does.

test('surface confirmed missing WHILE at the ceiling → fail immediately, never retry', () => {
  const d = decideLaunchWait({
    elapsedSec: 5, surfaceConfirmedMissing: true, atTerminalCapacity: true,
    attempt: 1, maxAttempts: 2,
  });
  assert.equal(d.action, 'fail', 'the cap is app-wide, so a second workspace is equally doomed');
  assert.equal(d.state, STATES.TERMINAL_RUNTIME_MISSING);
  assert.match(d.reason, /never attached a terminal/);
});

test('a missing surface ALONE keeps waiting — healthy launches attach up to ~40s late', () => {
  // Measured on the real machine: runtime-attach lag was 0.1s on seven
  // dispatched tabs but 35.5s and 39.9s on two others. Failing on one signal
  // here would be the #705 short-timeout-then-retry duplicate factory.
  for (const elapsedSec of [1, 10, 35, 40, 89]) {
    const d = decideLaunchWait({ elapsedSec, surfaceConfirmedMissing: true, atTerminalCapacity: false });
    assert.equal(d.action, 'wait', `${elapsedSec}s with capacity available must keep waiting`);
    assert.equal(d.state, STATES.AWAITING_INJECTION);
  }
});

test('being at the ceiling alone never fails a launch that is actually working', () => {
  // A workspace that got its terminal before the app filled up must not be
  // killed by a capacity reading taken at create time.
  assert.equal(decideLaunchWait({ elapsedSec: 5, atTerminalCapacity: true }).action, 'wait');
  assert.equal(decideLaunchWait({ wrapperAlive: true, elapsedSec: 200, atTerminalCapacity: true, surfaceConfirmedMissing: true }).action, 'wait');
  assert.equal(decideLaunchWait({ claudeRegistered: true, atTerminalCapacity: true, surfaceConfirmedMissing: true }).action, 'ok');
});

test('grace expiry relabels the diagnosis but does NOT change the retry budget', () => {
  // The surface signal alone is uncorroborated — capacity said we had room,
  // or said nothing at all — so "no terminal" may be this one workspace's
  // problem and a fresh attempt may well work. Dropping the retry here would
  // be a behavior regression smuggled in under a capacity fix (ship-check
  // catch); only branch 3b, where capacity CONFIRMS the cap, skips it.
  const swallowed = decideLaunchWait({ elapsedSec: 91, attempt: 1, maxAttempts: 2 });
  assert.deepEqual([swallowed.action, swallowed.state], ['retry', STATES.INJECTION_NEVER_RAN]);

  const noTerminal = decideLaunchWait({ elapsedSec: 91, attempt: 1, maxAttempts: 2, surfaceConfirmedMissing: true });
  assert.deepEqual([noTerminal.action, noTerminal.state], ['retry', STATES.TERMINAL_RUNTIME_MISSING],
    'same attempt budget as INJECTION_NEVER_RAN has always had — only the name is more precise');

  // Last attempt: both fail, as they always did.
  assert.equal(decideLaunchWait({ elapsedSec: 91, attempt: 2, maxAttempts: 2 }).action, 'fail');
  assert.equal(decideLaunchWait({ elapsedSec: 91, attempt: 2, maxAttempts: 2, surfaceConfirmedMissing: true }).action, 'fail');
});

test('a wrapper that ran and exited is still WRAPPER_EXITED, not a runtime problem', () => {
  // If the wrapper ever ran, a terminal existed — whatever read-screen says now.
  const d = decideLaunchWait({
    elapsedSec: 120, wrapperEverSeen: true, surfaceConfirmedMissing: true, atTerminalCapacity: true,
    attempt: 1, maxAttempts: 2,
  });
  assert.equal(d.state, STATES.WRAPPER_EXITED);
});

test('TERMINAL_RUNTIME_MISSING is a confirmed death, not a slow boot', () => {
  // isSlowBootFailure drives deadConfirmed in cmux-launch.js: a slow boot must
  // not be journaled as a corpse, but a workspace with no terminal is one.
  assert.equal(isSlowBootFailure(STATES.TERMINAL_RUNTIME_MISSING), false);
});

// ── probe cadence (task #1904 follow-up, /code-review findings 2 and 7) ─────

test('shouldProbeSurface: quiet early, then throttled — not one read-screen call every 3s', () => {
  // The launcher polls every PROBE_INTERVAL_SEC (3s). Probing on each of those
  // for a 90s grace is 30-60 extra cmux IPC round trips per launch, where
  // read-screen used to be consulted once.
  assert.equal(shouldProbeSurface({ elapsedSec: 3, lastProbeSec: null, graceSec: 90 }), false);
  assert.equal(shouldProbeSurface({ elapsedSec: SURFACE_PROBE_AFTER_SEC, lastProbeSec: null, graceSec: 90 }), true);
  assert.equal(shouldProbeSurface({ elapsedSec: 18, lastProbeSec: 15, graceSec: 90 }), false, 'inside the interval');
  assert.equal(shouldProbeSurface({ elapsedSec: 15 + SURFACE_PROBE_INTERVAL_SEC, lastProbeSec: 15, graceSec: 90 }), true);
  // ~6 probes across a 90s grace instead of ~30.
  let probes = 0; let last = null;
  for (let t = 0; t <= 90; t += 3) {
    if (shouldProbeSurface({ elapsedSec: t, lastProbeSec: last, graceSec: 90 })) { probes++; last = t; }
  }
  assert.equal(probes <= 8, true, `expected a handful of probes across the grace window, got ${probes}`);
  assert.equal(probes >= 2, true);
});

test('shouldProbeSurface: a grace SHORTER than the delay still gets probed', () => {
  // The verdict is the label that decides whether a ceiling observation is
  // recorded at all, so the deciding poll must have a reading. A flat 15s
  // delay silently disabled learning for every short-grace caller — the
  // launcher's own reclaim test (verifyTimeoutSec: 1) went from
  // 'terminal-runtime-missing' to 'injection-never-ran' when that landed.
  assert.equal(shouldProbeSurface({ elapsedSec: 1, lastProbeSec: null, graceSec: 1 }), true);
  assert.equal(shouldProbeSurface({ elapsedSec: 0.5, lastProbeSec: null, graceSec: 1 }), false);
  // And the last probe always lands within one interval of grace expiry.
  let last = null;
  for (let t = 0; t <= 90; t += 3) {
    if (shouldProbeSurface({ elapsedSec: t, lastProbeSec: last, graceSec: 90 })) last = t;
  }
  assert.equal(90 - last <= SURFACE_PROBE_INTERVAL_SEC, true, `stale by ${90 - last}s at the deciding poll`);
});

test('shouldReprobeCapacity: bounded by a total budget and a spacing, NOT by "we have an answer"', () => {
  // Two things the first cut got wrong, both caught in adversarial review:
  //  - an UNKNOWN reading cached as "not at capacity" (the probe fires seconds
  //    after new-workspace, when the cmux socket is busy creating workspaces);
  //  - a KNOWN reading assumed stable for a 90-360s wait, which is false when a
  //    dozen sessions dispatch on this host and can fill the last runtime.
  assert.equal(shouldReprobeCapacity({ attempts: 0, elapsedSec: 15, lastProbeSec: null }), true);
  assert.equal(shouldReprobeCapacity({ attempts: 1, elapsedSec: 20, lastProbeSec: 15 }), false,
    'spaced out, not asked on every 3s poll');
  assert.equal(shouldReprobeCapacity({ attempts: 1, elapsedSec: 15 + CAPACITY_REPROBE_INTERVAL_SEC, lastProbeSec: 15 }), true,
    'a known answer goes stale — it must be re-asked while the budget lasts');
  assert.equal(shouldReprobeCapacity({ attempts: CAPACITY_PROBE_MAX_ATTEMPTS, elapsedSec: 300, lastProbeSec: 100 }), false,
    'bounded in TOTAL — far below the ~120 round trips the launcher rejects');
});
