import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideGateAlerts, POWER_FLOOR, DURATION_MS } = require('./gate-ab-monitor-rules.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const sum = (control, eoc, extra = {}) => ({
  tagged: true,
  arms: {
    control: { shown: control.shown ?? 0, dismissed: control.dismissed ?? 0, captured: 0 },
    'end-of-content': { shown: eoc.shown ?? 0, dismissed: eoc.dismissed ?? 0, captured: 0 },
    fallback: { shown: 5, dismissed: 5, captured: 0 },
  },
  mobileBouncePct: 64.15,
  ...extra,
});
const kinds = (r) => r.alerts.map((a) => a.kind);

test('pre-flag / fallback-only traffic: silent, but bounce baseline keeps rolling', () => {
  const r = decideGateAlerts({ tagged: true, arms: { fallback: { shown: 10, dismissed: 10 } }, mobileBouncePct: 63.2 }, {}, NOW);
  assert.deepEqual(r.alerts, []);
  assert.equal(r.state.baselineBouncePct, 63.2);
  assert.equal(r.state.startedAt, undefined);
});

test('first real-arm impressions: experiment-live email fires once, baseline frozen', () => {
  const r1 = decideGateAlerts(sum({ shown: 12 }, { shown: 9 }), { baselineBouncePct: 63.2 }, NOW);
  assert.ok(kinds(r1).includes('experiment-live'));
  assert.equal(r1.state.startedAt, NOW);
  assert.equal(r1.state.baselineBouncePct, 63.2, 'pre-launch baseline is kept, not overwritten');
  const r2 = decideGateAlerts(sum({ shown: 40 }, { shown: 38 }), r1.state, NOW + DAY);
  assert.ok(!kinds(r2).includes('experiment-live'), 'live alert is once-only');
});

test('power-reached fires exactly once when BOTH arms pass the floor', () => {
  const st = { startedAt: NOW, baselineBouncePct: 64 };
  const below = decideGateAlerts(sum({ shown: POWER_FLOOR }, { shown: POWER_FLOOR - 1 }), st, NOW + 20 * DAY);
  assert.ok(!kinds(below).includes('power-reached'), 'one arm below floor → no alert');
  const at = decideGateAlerts(sum({ shown: POWER_FLOOR }, { shown: POWER_FLOOR }), below.state, NOW + 21 * DAY);
  assert.ok(kinds(at).includes('power-reached'));
  const again = decideGateAlerts(sum({ shown: POWER_FLOOR + 500 }, { shown: POWER_FLOOR + 500 }), at.state, NOW + 22 * DAY);
  assert.ok(!kinds(again).includes('power-reached'), 'once-only');
});

test('duration-reached fires once at 8 weeks even if power unmet', () => {
  const st = { startedAt: NOW, baselineBouncePct: 64 };
  const early = decideGateAlerts(sum({ shown: 100 }, { shown: 100 }), st, NOW + DURATION_MS - DAY);
  assert.ok(!kinds(early).includes('duration-reached'));
  const at = decideGateAlerts(sum({ shown: 100 }, { shown: 100 }), early.state, NOW + DURATION_MS);
  const alert = at.alerts.find((a) => a.kind === 'duration-reached');
  assert.ok(alert && /NOT met/.test(alert.description), 'says the floor was not met');
});

test('bounce breach: fires past +3pts with 7d cooldown', () => {
  const st = { startedAt: NOW, baselineBouncePct: 64 };
  const ok = decideGateAlerts(sum({ shown: 50 }, { shown: 50 }, { mobileBouncePct: 66.5 }), st, NOW + DAY);
  assert.ok(!kinds(ok).includes('bounce-breach'), '+2.5pts under guardrail');
  const bad = decideGateAlerts(sum({ shown: 50 }, { shown: 50 }, { mobileBouncePct: 67.5 }), ok.state, NOW + 2 * DAY);
  assert.ok(kinds(bad).includes('bounce-breach'));
  const cooled = decideGateAlerts(sum({ shown: 50 }, { shown: 50 }, { mobileBouncePct: 68 }), bad.state, NOW + 3 * DAY);
  assert.ok(!kinds(cooled).includes('bounce-breach'), 'inside 7d cooldown');
});

test('dismissal skew: needs both arms >=200 shown and >15pt gap', () => {
  const st = { startedAt: NOW, baselineBouncePct: 64 };
  const small = decideGateAlerts(sum({ shown: 150, dismissed: 140 }, { shown: 150, dismissed: 30 }), st, NOW + DAY);
  assert.ok(!kinds(small).includes('dismissal-skew'), 'under sample floor');
  const skew = decideGateAlerts(sum({ shown: 300, dismissed: 260 }, { shown: 300, dismissed: 150 }), st, NOW + DAY);
  assert.ok(kinds(skew).includes('dismissal-skew'), '86.7% vs 50% → alert');
});

test('weekly summary is discord-only (never email) and present whenever live', () => {
  const r = decideGateAlerts(sum({ shown: 10 }, { shown: 10 }), { startedAt: NOW, baselineBouncePct: 64 }, NOW + DAY);
  const weekly = r.alerts.find((a) => a.kind === 'weekly-summary');
  assert.ok(weekly);
  assert.equal(weekly.email, false);
  assert.notEqual(weekly.severity, 'error', 'must stay below the emailable-severity line');
});
