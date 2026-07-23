import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { updateHeartbeatState } = require('./outlet-heartbeat-state.js');

describe('updateHeartbeatState', () => {
  test('first red run: no ACTION, streak = 1', () => {
    const { state, newlyActionable } = updateHeartbeatState(
      {}, [{ outletId: 'broadwaynews', market: 'broadway', status: 'red' }], '2026-07-22',
    );
    assert.equal(state['broadwaynews::broadway'].redStreak, 1);
    assert.deepEqual(newlyActionable, []);
  });

  test('second consecutive red run: crosses threshold -> ACTION', () => {
    const prev = { 'broadwaynews::broadway': { redStreak: 1, lastStatus: 'red' } };
    const { state, newlyActionable } = updateHeartbeatState(
      prev, [{ outletId: 'broadwaynews', market: 'broadway', status: 'red' }], '2026-07-29',
    );
    assert.equal(state['broadwaynews::broadway'].redStreak, 2);
    assert.equal(newlyActionable.length, 1);
    assert.equal(newlyActionable[0].outletId, 'broadwaynews');
  });

  test('third consecutive red run: already actionable, does NOT re-fire (dedup)', () => {
    const prev = { 'broadwaynews::broadway': { redStreak: 2, lastStatus: 'red' } };
    const { state, newlyActionable } = updateHeartbeatState(
      prev, [{ outletId: 'broadwaynews', market: 'broadway', status: 'red' }], '2026-08-05',
    );
    assert.equal(state['broadwaynews::broadway'].redStreak, 3);
    assert.deepEqual(newlyActionable, []);
  });

  test('recovery resets the streak to 0', () => {
    const prev = { 'broadwaynews::broadway': { redStreak: 3, lastStatus: 'red' } };
    const { state } = updateHeartbeatState(
      prev, [{ outletId: 'broadwaynews', market: 'broadway', status: 'green' }], '2026-08-12',
    );
    assert.equal(state['broadwaynews::broadway'].redStreak, 0);
  });

  test('a fresh red streak after recovery fires ACTION again on its own 2nd week', () => {
    let state = {};
    ({ state } = updateHeartbeatState(state, [{ outletId: 'ap', market: 'broadway', status: 'red' }], 'w1'));
    ({ state } = updateHeartbeatState(state, [{ outletId: 'ap', market: 'broadway', status: 'green' }], 'w2'));
    ({ state } = updateHeartbeatState(state, [{ outletId: 'ap', market: 'broadway', status: 'red' }], 'w3'));
    const r4 = updateHeartbeatState(state, [{ outletId: 'ap', market: 'broadway', status: 'red' }], 'w4');
    assert.equal(r4.newlyActionable.length, 1, 'streak reset by the green week means w3+w4 counts as a fresh 2-run streak');
  });

  test('unknown status behaves like non-red (resets streak, never actionable)', () => {
    const prev = { 'x::broadway': { redStreak: 1, lastStatus: 'red' } };
    const { state, newlyActionable } = updateHeartbeatState(
      prev, [{ outletId: 'x', market: 'broadway', status: 'unknown' }], 'w2',
    );
    assert.equal(state['x::broadway'].redStreak, 0);
    assert.deepEqual(newlyActionable, []);
  });
});
