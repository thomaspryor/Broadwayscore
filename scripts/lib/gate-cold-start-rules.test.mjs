import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decideGateColdStartAlerts, ALERT_CAPTURES_PER_WEEK, CAPTURE_COLLAPSE_STREAK_WEEKS,
  MIN_SHOWN_FOR_ALERT, IMPRESSION_SPLIT_MIN_SHOWN, IMPRESSION_SPLIT_MIN_RATIO, PRIMARY_MIN_DAYS,
} = require('./gate-cold-start-rules.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const kinds = (r) => r.alerts.map((a) => a.kind);

function healthyRecent(overrides = {}) {
  return {
    flagHealthy: true,
    totalCapturesPerWeek: 3,
    arms: {
      control: { exposed: 50, shown: 40, dismissed: 5, captured: 2 },
      'cold-start': { exposed: 50, shown: 4, dismissed: 1, captured: 1 },
      unexposed: { exposed: 0, shown: 0, dismissed: 0, captured: 0 },
    },
    ...overrides,
  };
}

function windows(recentOverrides = {}, cumulativeOverrides = {}) {
  return { recent: healthyRecent(recentOverrides), cumulative: { effectiveDays: 10, experimentStart: '2026-07-21', arms: healthyRecent().arms, ...cumulativeOverrides } };
}

test('healthy week: no actionable alerts, only weekly-summary', () => {
  const r = decideGateColdStartAlerts(windows(), {}, NOW);
  assert.deepEqual(kinds(r), ['weekly-summary']);
});

test('flag-unhealthy fires when flagHealthy is false, carries the problem text', () => {
  const r = decideGateColdStartAlerts(windows({ flagHealthy: false, flagHealthProblem: 'variant split drifted' }), {}, NOW);
  const alert = r.alerts.find((a) => a.kind === 'flag-unhealthy');
  assert.ok(alert);
  assert.equal(alert.email, true);
  assert.equal(alert.severity, 'error');
  assert.ok(alert.description.includes('variant split drifted'));
  assert.ok(alert.stampKey);
});

test('flag-unhealthy respects cooldown: same-week re-run does not double-alert, later week does', () => {
  const first = decideGateColdStartAlerts(windows({ flagHealthy: false }), {}, NOW);
  const sameWeek = decideGateColdStartAlerts(windows({ flagHealthy: false }), first.state, NOW + DAY);
  assert.ok(!kinds(sameWeek).includes('flag-unhealthy'), 'inside cooldown');
  const nextWeek = decideGateColdStartAlerts(windows({ flagHealthy: false }), sameWeek.state, NOW + 7 * DAY);
  assert.ok(kinds(nextWeek).includes('flag-unhealthy'), 'still broken after cooldown clears → re-alerts');
});

test('capture-collapse requires 2 CONSECUTIVE meaningful weeks below floor, not 1', () => {
  const belowFloorArms = { control: { exposed: 50, shown: 20, dismissed: 5, captured: 0 }, 'cold-start': { exposed: 50, shown: 4, dismissed: 1, captured: 0 } };
  const week1 = decideGateColdStartAlerts(
    windows({ totalCapturesPerWeek: ALERT_CAPTURES_PER_WEEK - 0.5, arms: belowFloorArms }), {}, NOW);
  assert.ok(!kinds(week1).includes('capture-collapse'), 'must not fire on the first below-floor week');
  assert.equal(week1.state.consecutiveBelowCaptureFloor, 1);
  const week2 = decideGateColdStartAlerts(
    windows({ totalCapturesPerWeek: ALERT_CAPTURES_PER_WEEK - 0.5, arms: belowFloorArms }), week1.state, NOW + 7 * DAY);
  assert.ok(kinds(week2).includes('capture-collapse'), 'second consecutive below-floor week fires');
  const alert = week2.alerts.find((a) => a.kind === 'capture-collapse');
  assert.equal(alert.email, true);
  assert.equal(alert.severity, 'error');
});

test(`capture-collapse streak resets to 0 the moment a week clears the ${ALERT_CAPTURES_PER_WEEK}/wk floor`, () => {
  const belowArms = { control: { exposed: 50, shown: 20, dismissed: 5, captured: 0 }, 'cold-start': { exposed: 50, shown: 4, dismissed: 1, captured: 0 } };
  const week1 = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: belowArms }), {}, NOW);
  assert.equal(week1.state.consecutiveBelowCaptureFloor, 1);
  const week2 = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 5 }), week1.state, NOW + 7 * DAY);
  assert.equal(week2.state.consecutiveBelowCaptureFloor, 0);
  const week3 = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: belowArms }), week2.state, NOW + 14 * DAY);
  assert.ok(!kinds(week3).includes('capture-collapse'), 'streak restarted, only 1 consecutive week so far');
});

test('capture-collapse streak also resets across a non-meaningful gap week (below-floor / ramp-up / below-floor is NOT 2 consecutive)', () => {
  const belowArms = { control: { exposed: 50, shown: 20, dismissed: 5, captured: 0 }, 'cold-start': { exposed: 50, shown: 4, dismissed: 1, captured: 0 } };
  const tinyArms = { control: { exposed: 5, shown: 2, dismissed: 0, captured: 0 }, 'cold-start': { exposed: 5, shown: 1, dismissed: 0, captured: 0 } };
  const week1 = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: belowArms }), {}, NOW);
  assert.equal(week1.state.consecutiveBelowCaptureFloor, 1);
  const gapWeek = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: tinyArms }), week1.state, NOW + 7 * DAY);
  assert.equal(gapWeek.state.consecutiveBelowCaptureFloor, 0, 'a non-meaningful window must break the streak, not leave it dangling');
  const week3 = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: belowArms }), gapWeek.state, NOW + 14 * DAY);
  assert.ok(!kinds(week3).includes('capture-collapse'), 'below-floor / gap / below-floor is only 1 consecutive meaningful week, not 2');
  assert.equal(week3.state.consecutiveBelowCaptureFloor, 1);
});

test(`capture-collapse does not judge off a near-empty ramp-up window (below ${MIN_SHOWN_FOR_ALERT} combined shown)`, () => {
  const tinyArms = { control: { exposed: 5, shown: 2, dismissed: 0, captured: 0 }, 'cold-start': { exposed: 5, shown: 1, dismissed: 0, captured: 0 } };
  const week1 = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: tinyArms }), {}, NOW);
  const week2 = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: tinyArms }), week1.state, NOW + 7 * DAY);
  assert.ok(!kinds(week2).includes('capture-collapse'), 'ramp-up traffic must never accumulate a collapse streak');
  assert.equal(week2.state.consecutiveBelowCaptureFloor ?? 0, 0);
});

test('funnel-stalled fires when traffic that reached the floor before drops back under it', () => {
  const healthy = decideGateColdStartAlerts(windows(), {}, NOW);
  assert.equal(healthy.state.everReachedTrafficFloor, true);
  const tinyArms = { control: { exposed: 5, shown: 2, dismissed: 0, captured: 0 }, 'cold-start': { exposed: 5, shown: 1, dismissed: 0, captured: 0 } };
  const stalled = decideGateColdStartAlerts(windows({ arms: tinyArms }), healthy.state, NOW + 7 * DAY);
  assert.ok(kinds(stalled).includes('funnel-stalled'));
  const alert = stalled.alerts.find((a) => a.kind === 'funnel-stalled');
  assert.equal(alert.email, true);
  assert.ok(alert.stampKey);
});

test('funnel-stalled does not fire on ramp-up when the floor was never reached before', () => {
  const tinyArms = { control: { exposed: 5, shown: 2, dismissed: 0, captured: 0 }, 'cold-start': { exposed: 5, shown: 1, dismissed: 0, captured: 0 } };
  const r = decideGateColdStartAlerts(windows({ arms: tinyArms }), {}, NOW);
  assert.ok(!kinds(r).includes('funnel-stalled'));
});

test(`impression-split-broken fires when control:cold-start drifts toward parity with >= ${IMPRESSION_SPLIT_MIN_SHOWN} combined shown`, () => {
  const parityArms = { control: { exposed: 50, shown: 20, dismissed: 2, captured: 1 }, 'cold-start': { exposed: 50, shown: 18, dismissed: 2, captured: 1 } };
  const r = decideGateColdStartAlerts(windows({ arms: parityArms }), {}, NOW);
  const alert = r.alerts.find((a) => a.kind === 'impression-split-broken');
  assert.ok(alert, 'ratio well under IMPRESSION_SPLIT_MIN_RATIO must fire');
  assert.equal(alert.email, true);
});

test('impression-split-broken does not fire when the expected ~10:1 skew holds', () => {
  const r = decideGateColdStartAlerts(windows(), {}, NOW); // healthyRecent() control:40 cold-start:4 = 10:1
  assert.ok(!kinds(r).includes('impression-split-broken'));
});

test(`impression-split-broken does not judge off too little combined traffic (< ${IMPRESSION_SPLIT_MIN_SHOWN} shown)`, () => {
  const smallParityArms = { control: { exposed: 10, shown: 5, dismissed: 0, captured: 0 }, 'cold-start': { exposed: 10, shown: 5, dismissed: 0, captured: 0 } };
  const r = decideGateColdStartAlerts(windows({ arms: smallParityArms }), {}, NOW);
  assert.ok(!kinds(r).includes('impression-split-broken'), 'not enough traffic to judge the split yet');
});

test(`primary-ready fires once when cumulative.effectiveDays crosses ${PRIMARY_MIN_DAYS}`, () => {
  const before = decideGateColdStartAlerts(windows({}, { effectiveDays: PRIMARY_MIN_DAYS - 1 }), {}, NOW);
  assert.ok(!kinds(before).includes('primary-ready'));
  const at = decideGateColdStartAlerts(windows({}, { effectiveDays: PRIMARY_MIN_DAYS }), before.state, NOW + DAY);
  assert.ok(kinds(at).includes('primary-ready'));
  const alert = at.alerts.find((a) => a.kind === 'primary-ready');
  assert.equal(alert.email, true);
  assert.ok(alert.description.includes('control'));
  assert.ok(alert.description.includes('cold-start'));
  // Fires only once — a later run past the milestone must not re-alert.
  const later = decideGateColdStartAlerts(windows({}, { effectiveDays: PRIMARY_MIN_DAYS + 20 }), at.state, NOW + 30 * DAY);
  assert.ok(!kinds(later).includes('primary-ready'));
});

test('weekly-summary is log-only (never email) and always present', () => {
  const r = decideGateColdStartAlerts(windows(), {}, NOW);
  const weekly = r.alerts.find((a) => a.kind === 'weekly-summary');
  assert.ok(weekly);
  assert.equal(weekly.email, false);
  assert.equal(weekly.logOnly, true);
});

test('delivery-retry contract: reverting the stamp makes capture-collapse fire again', () => {
  const belowArms = { control: { exposed: 50, shown: 20, dismissed: 5, captured: 0 }, 'cold-start': { exposed: 50, shown: 4, dismissed: 1, captured: 0 } };
  const week1 = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: belowArms }), {}, NOW);
  const week2 = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: belowArms }), week1.state, NOW + 7 * DAY);
  const stampKey = week2.alerts.find((a) => a.kind === 'capture-collapse').stampKey;
  const st = { ...week2.state };
  delete st[stampKey];
  const retry = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: belowArms }), st, NOW + 8 * DAY);
  assert.ok(kinds(retry).includes('capture-collapse'), 'reverted stamp → alert retries even mid-cooldown window');
});

test(`capture-collapse cooldown independent from other alert kinds (${CAPTURE_COLLAPSE_STREAK_WEEKS}-week streak, then 6d cooldown)`, () => {
  const belowArms = { control: { exposed: 50, shown: 20, dismissed: 5, captured: 0 }, 'cold-start': { exposed: 50, shown: 4, dismissed: 1, captured: 0 } };
  let st = {};
  let last;
  for (let i = 0; i < CAPTURE_COLLAPSE_STREAK_WEEKS; i++) {
    last = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: belowArms }), st, NOW + i * 7 * DAY);
    st = last.state;
  }
  assert.ok(kinds(last).includes('capture-collapse'));
  const lastRunAtMs = NOW + (CAPTURE_COLLAPSE_STREAK_WEEKS - 1) * 7 * DAY;
  const sameWindow = decideGateColdStartAlerts(windows({ totalCapturesPerWeek: 0, arms: belowArms }), st, lastRunAtMs + DAY);
  assert.ok(!kinds(sameWindow).includes('capture-collapse'), 'inside 6d cooldown');
});
