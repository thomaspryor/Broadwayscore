import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideLaunchWait, isSlowBootFailure, STATES } = require('./cmux-launch-state.js');

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
