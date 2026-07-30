import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { updateHeartbeatState, getActionableOutletRows } = require('./outlet-heartbeat-state.js');

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

  test('a row missing from this run (transient data gap) is carried forward unchanged, not dropped or reset', () => {
    const prev = {
      'broadwaynews::broadway': { redStreak: 1, lastStatus: 'red', lastCheckedAt: 'w1' },
    };
    // This run's cadenceRows doesn't include broadwaynews at all (e.g. a partial
    // reviews.json read) — only an unrelated outlet reported.
    const { state, newlyActionable } = updateHeartbeatState(
      prev, [{ outletId: 'nytimes', market: 'broadway', status: 'green' }], 'w2',
    );
    assert.deepEqual(state['broadwaynews::broadway'], prev['broadwaynews::broadway'],
      'missing row must be carried forward byte-identical, not deleted or reset to 0');
    assert.deepEqual(newlyActionable, []);
  });

  test('a carried-forward row resumes its streak correctly once data returns', () => {
    let state = { 'broadwaynews::broadway': { redStreak: 1, lastStatus: 'red', lastCheckedAt: 'w1' } };
    // w2: transient gap, row absent
    ({ state } = updateHeartbeatState(state, [{ outletId: 'nytimes', market: 'broadway', status: 'green' }], 'w2'));
    assert.equal(state['broadwaynews::broadway'].redStreak, 1, 'streak survived the gap');
    // w3: data returns, still red -> should cross the 2-consecutive threshold
    const r3 = updateHeartbeatState(
      state, [{ outletId: 'broadwaynews', market: 'broadway', status: 'red' }], 'w3',
    );
    assert.equal(r3.state['broadwaynews::broadway'].redStreak, 2);
    assert.equal(r3.newlyActionable.length, 1);
  });
});

describe('getActionableOutletRows (card #643 baseline/ack)', () => {
  const rows = [
    { outletId: 'newsday', market: 'broadway', silentDays: 2370, thresholdDays: 45 },
    { outletId: 'freshbreak', market: 'broadway', silentDays: 90, thresholdDays: 45 },
  ];

  test('rows below redStreak threshold are never actionable, baseline or not', () => {
    const state = { 'newsday::broadway': { redStreak: 1 }, 'freshbreak::broadway': { redStreak: 1 } };
    const { actionable, baselinedCount, totalCrossedThreshold } = getActionableOutletRows(rows, state, new Set());
    assert.deepEqual(actionable, []);
    assert.equal(baselinedCount, 0);
    assert.equal(totalCrossedThreshold, 0);
  });

  test('a baselined key crossing the threshold is excluded from actionable but counted', () => {
    const state = { 'newsday::broadway': { redStreak: 2 }, 'freshbreak::broadway': { redStreak: 2 } };
    const baseline = new Set(['newsday::broadway']);
    const { actionable, baselinedCount, totalCrossedThreshold } = getActionableOutletRows(rows, state, baseline);
    assert.equal(actionable.length, 1);
    assert.equal(actionable[0].outletId, 'freshbreak');
    assert.equal(baselinedCount, 1);
    assert.equal(totalCrossedThreshold, 2);
  });

  test('no baseline given: everything crossing the threshold is actionable', () => {
    const state = { 'newsday::broadway': { redStreak: 2 }, 'freshbreak::broadway': { redStreak: 2 } };
    const { actionable, baselinedCount } = getActionableOutletRows(rows, state);
    assert.equal(actionable.length, 2);
    assert.equal(baselinedCount, 0);
  });

  test('actionable rows sort worst (most silentDays) first', () => {
    const state = { 'newsday::broadway': { redStreak: 2 }, 'freshbreak::broadway': { redStreak: 2 } };
    const { actionable } = getActionableOutletRows(rows, state, new Set());
    assert.equal(actionable[0].outletId, 'newsday');
    assert.equal(actionable[1].outletId, 'freshbreak');
  });
});
