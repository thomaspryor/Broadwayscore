import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFlagParityAlerts, COOLDOWN_MS } from './flag-parity-rules.js';

function alertKinds(alerts) {
  return alerts.map((a) => a.kind);
}

test('all-healthy, nothing unregistered: only the log-only weekly summary fires', () => {
  const input = {
    flagHealth: [
      { key: 'gate-cold-start', ok: true, problem: null },
      { key: 'ticket-single-button', ok: true, problem: null },
    ],
    unregistered: [],
  };
  const { alerts } = decideFlagParityAlerts(input, {}, 1000);
  assert.deepEqual(alertKinds(alerts), ['weekly-summary']);
  assert.equal(alerts[0].email, false);
});

test('a registered flag drifting unhealthy fires an emailed alert with a per-flag stampKey', () => {
  const input = {
    flagHealth: [{ key: 'gate-cold-start', ok: false, problem: 'FLAG DOES NOT EXIST' }],
    unregistered: [],
  };
  const { alerts, state } = decideFlagParityAlerts(input, {}, 1000);
  const unhealthy = alerts.find((a) => a.kind === 'flag-unhealthy');
  assert.ok(unhealthy);
  assert.equal(unhealthy.email, true);
  assert.equal(unhealthy.stampKey, 'lastUnhealthyAlertAt:gate-cold-start');
  assert.equal(state['lastUnhealthyAlertAt:gate-cold-start'], 1000);
});

test('unhealthy alert is suppressed within the cooldown window', () => {
  const input = { flagHealth: [{ key: 'gate-cold-start', ok: false, problem: 'x' }], unregistered: [] };
  const state = { 'lastUnhealthyAlertAt:gate-cold-start': 1000 };
  const { alerts } = decideFlagParityAlerts(input, state, 1000 + COOLDOWN_MS - 1);
  assert.equal(alerts.some((a) => a.kind === 'flag-unhealthy'), false);
});

test('unhealthy alert re-fires after the cooldown elapses', () => {
  const input = { flagHealth: [{ key: 'gate-cold-start', ok: false, problem: 'x' }], unregistered: [] };
  const state = { 'lastUnhealthyAlertAt:gate-cold-start': 1000 };
  const { alerts } = decideFlagParityAlerts(input, state, 1000 + COOLDOWN_MS);
  assert.equal(alerts.some((a) => a.kind === 'flag-unhealthy'), true);
});

test('recovery clears the cooldown stamp so a future recurrence alerts fresh', () => {
  const input = { flagHealth: [{ key: 'gate-cold-start', ok: true, problem: null }], unregistered: [] };
  const state = { 'lastUnhealthyAlertAt:gate-cold-start': 1000 };
  const { state: next } = decideFlagParityAlerts(input, state, 2000);
  assert.equal('lastUnhealthyAlertAt:gate-cold-start' in next, false);
});

test('two independently-unhealthy flags each get their own alert (no cross-suppression)', () => {
  const input = {
    flagHealth: [
      { key: 'gate-cold-start', ok: false, problem: 'a' },
      { key: 'ticket-single-button', ok: false, problem: 'b' },
    ],
    unregistered: [],
  };
  const { alerts } = decideFlagParityAlerts(input, {}, 1000);
  const unhealthy = alerts.filter((a) => a.kind === 'flag-unhealthy');
  assert.equal(unhealthy.length, 2);
});

test('an unregistered flag key referenced in src/ fires an emailed alert naming the file', () => {
  const input = { flagHealth: [], unregistered: [{ key: 'totally-fake-flag', files: ['src/foo.tsx'] }] };
  const { alerts } = decideFlagParityAlerts(input, {}, 1000);
  const unreg = alerts.find((a) => a.kind === 'code-unregistered');
  assert.ok(unreg);
  assert.equal(unreg.email, true);
  assert.match(unreg.description, /totally-fake-flag/);
  assert.match(unreg.description, /src\/foo\.tsx/);
});

test('unregistered alert is suppressed within cooldown, and clears once resolved', () => {
  const input = { flagHealth: [], unregistered: [{ key: 'totally-fake-flag', files: ['src/foo.tsx'] }] };
  const state = { lastUnregisteredAlertAt: 1000 };
  const { alerts: cooled } = decideFlagParityAlerts(input, state, 1000 + COOLDOWN_MS - 1);
  assert.equal(cooled.some((a) => a.kind === 'code-unregistered'), false);

  const resolvedInput = { flagHealth: [], unregistered: [] };
  const { state: nextState } = decideFlagParityAlerts(resolvedInput, state, 1000 + 1);
  assert.equal('lastUnregisteredAlertAt' in nextState, false);
});

test('weekly-summary always fires last and is always log-only', () => {
  const input = {
    flagHealth: [{ key: 'gate-cold-start', ok: false, problem: 'x' }],
    unregistered: [{ key: 'fake', files: ['a.tsx'] }],
  };
  const { alerts } = decideFlagParityAlerts(input, {}, 1000);
  const summary = alerts[alerts.length - 1];
  assert.equal(summary.kind, 'weekly-summary');
  assert.equal(summary.logOnly, true);
  assert.match(summary.description, /1 registered flag/);
});
