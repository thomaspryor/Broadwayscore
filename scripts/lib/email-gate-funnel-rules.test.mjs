import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decideEmailGateFunnelAlerts, ALERT_CAPTURES_PER_WEEK, MIN_IMPRESSIONS_FOR_ALERT,
  SUSTAINED_DECLINE_WEEKS, SUSTAINED_DECLINE_THRESHOLD,
} = require('./email-gate-funnel-rules.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const kinds = (r) => r.alerts.map((a) => a.kind);

test('capturesPerWeek fallback: falls back to summary.captured when capturesPerWeek is missing (matches --days=7 production call)', () => {
  const collapsed = decideEmailGateFunnelAlerts({ impressions: 100, captured: 0 }, {}, NOW);
  assert.ok(kinds(collapsed).includes('capture-collapse'), 'missing capturesPerWeek must still detect a collapse via captured');
  const healthy = decideEmailGateFunnelAlerts({ impressions: 100, captured: 5 }, {}, NOW);
  assert.ok(!kinds(healthy).includes('capture-collapse'), 'missing capturesPerWeek must not false-positive when captured is healthy');
});

test('ramp-up window (impressions below floor): no collapse alert, logged as ramp-up', () => {
  const r = decideEmailGateFunnelAlerts({ impressions: 21, captured: 0, capturesPerWeek: 0 }, {}, NOW);
  assert.ok(!kinds(r).includes('capture-collapse'), 'must not judge collapse off a near-empty window');
  assert.ok(kinds(r).includes('ramp-up'));
  assert.ok(kinds(r).includes('weekly-summary'));
});

test('healthy week: captures/wk above floor → no collapse alert', () => {
  const r = decideEmailGateFunnelAlerts({ impressions: 100, captured: 3, capturesPerWeek: 3 }, {}, NOW);
  assert.ok(!kinds(r).includes('capture-collapse'));
});

test('collapse: enough impressions but captures/wk under floor → email alert fires', () => {
  const r = decideEmailGateFunnelAlerts({ impressions: 100, captured: 0, capturesPerWeek: 0 }, {}, NOW);
  const alert = r.alerts.find((a) => a.kind === 'capture-collapse');
  assert.ok(alert, 'collapse alert must fire');
  assert.equal(alert.email, true);
  assert.equal(alert.severity, 'error');
  assert.ok(alert.stampKey, 'must carry stampKey for delivery-retry contract');
  assert.equal(r.state[alert.stampKey], NOW);
});

test('collapse alert threshold is exclusive at the boundary', () => {
  const atFloor = decideEmailGateFunnelAlerts({ impressions: MIN_IMPRESSIONS_FOR_ALERT, captured: ALERT_CAPTURES_PER_WEEK, capturesPerWeek: ALERT_CAPTURES_PER_WEEK }, {}, NOW);
  assert.ok(!kinds(atFloor).includes('capture-collapse'), 'exactly at the floor is not a collapse');
  const belowFloor = decideEmailGateFunnelAlerts({ impressions: MIN_IMPRESSIONS_FOR_ALERT, captured: 0, capturesPerWeek: ALERT_CAPTURES_PER_WEEK - 0.01 }, {}, NOW);
  assert.ok(kinds(belowFloor).includes('capture-collapse'));
});

test('delivery-retry contract: reverting the stamp makes the alert fire again', () => {
  const first = decideEmailGateFunnelAlerts({ impressions: 100, captured: 0, capturesPerWeek: 0 }, {}, NOW);
  const stampKey = first.alerts.find((a) => a.kind === 'capture-collapse').stampKey;
  const st = { ...first.state };
  delete st[stampKey];
  const retry = decideEmailGateFunnelAlerts({ impressions: 100, captured: 0, capturesPerWeek: 0 }, st, NOW + DAY);
  assert.ok(kinds(retry).includes('capture-collapse'), 'reverted stamp → alert retries');
});

test('cooldown: same-week re-run does not double-alert, but a later week does', () => {
  const first = decideEmailGateFunnelAlerts({ impressions: 100, captured: 0, capturesPerWeek: 0 }, {}, NOW);
  const sameWeek = decideEmailGateFunnelAlerts({ impressions: 100, captured: 0, capturesPerWeek: 0 }, first.state, NOW + DAY);
  assert.ok(!kinds(sameWeek).includes('capture-collapse'), 'inside cooldown');
  const nextWeek = decideEmailGateFunnelAlerts({ impressions: 100, captured: 0, capturesPerWeek: 0 }, sameWeek.state, NOW + 7 * DAY);
  assert.ok(kinds(nextWeek).includes('capture-collapse'), 'collapse persisting into next week re-alerts');
});

test('funnel-stalled: impressions that reached the floor then collapse fire an actionable alert, not silent ramp-up', () => {
  const healthy = decideEmailGateFunnelAlerts({ impressions: 100, captured: 5, capturesPerWeek: 5 }, {}, NOW);
  assert.equal(healthy.state.everReachedFloor, true);
  const stalled = decideEmailGateFunnelAlerts({ impressions: 5, captured: 0, capturesPerWeek: 0 }, healthy.state, NOW + 7 * DAY);
  assert.ok(kinds(stalled).includes('funnel-stalled'), 'a regression after healthy traffic must be actionable');
  assert.ok(!kinds(stalled).includes('ramp-up'), 'must not also log a misleading ramp-up note');
  const alert = stalled.alerts.find((a) => a.kind === 'funnel-stalled');
  assert.equal(alert.email, true);
  assert.ok(alert.stampKey);
});

test('ramp-up (not funnel-stalled) when the floor was never reached before', () => {
  const r = decideEmailGateFunnelAlerts({ impressions: 5, captured: 0, capturesPerWeek: 0 }, {}, NOW);
  assert.ok(kinds(r).includes('ramp-up'));
  assert.ok(!kinds(r).includes('funnel-stalled'));
  assert.equal(r.state.everReachedFloor, undefined);
});

test('funnel-stalled has its own 6-day cooldown independent of capture-collapse', () => {
  const healthy = decideEmailGateFunnelAlerts({ impressions: 100, captured: 5, capturesPerWeek: 5 }, {}, NOW);
  const first = decideEmailGateFunnelAlerts({ impressions: 0, captured: 0, capturesPerWeek: 0 }, healthy.state, NOW + 7 * DAY);
  assert.ok(kinds(first).includes('funnel-stalled'));
  const sameWindow = decideEmailGateFunnelAlerts({ impressions: 0, captured: 0, capturesPerWeek: 0 }, first.state, NOW + 8 * DAY);
  assert.ok(!kinds(sameWindow).includes('funnel-stalled'), 'inside cooldown');
  const later = decideEmailGateFunnelAlerts({ impressions: 0, captured: 0, capturesPerWeek: 0 }, sameWindow.state, NOW + 14 * DAY);
  assert.ok(kinds(later).includes('funnel-stalled'), 'still stalled after cooldown clears → re-alerts');
});

test(`sustained-decline: ${SUSTAINED_DECLINE_WEEKS} consecutive weeks below ${SUSTAINED_DECLINE_THRESHOLD}/wk but above the hard floor fires once`, () => {
  let st = {};
  let last;
  for (let i = 0; i < SUSTAINED_DECLINE_WEEKS - 1; i++) {
    last = decideEmailGateFunnelAlerts({ impressions: 100, captured: 2, capturesPerWeek: 2 }, st, NOW + i * 7 * DAY);
    st = last.state;
    assert.ok(!kinds(last).includes('sustained-decline'), `must not fire before ${SUSTAINED_DECLINE_WEEKS} weeks of history`);
  }
  const third = decideEmailGateFunnelAlerts({ impressions: 100, captured: 2, capturesPerWeek: 2 }, st, NOW + (SUSTAINED_DECLINE_WEEKS - 1) * 7 * DAY);
  assert.ok(kinds(third).includes('sustained-decline'));
  const alert = third.alerts.find((a) => a.kind === 'sustained-decline');
  assert.equal(alert.email, true);
  assert.equal(third.state.recentCaptures.length, SUSTAINED_DECLINE_WEEKS);
});

test('sustained-decline history resets across a non-meaningful gap week (low / low / ramp-up / low is NOT 3 consecutive)', () => {
  let st = {};
  let last;
  for (let i = 0; i < SUSTAINED_DECLINE_WEEKS - 1; i++) {
    last = decideEmailGateFunnelAlerts({ impressions: 100, captured: 2, capturesPerWeek: 2 }, st, NOW + i * 7 * DAY);
    st = last.state;
  }
  assert.equal(st.recentCaptures.length, SUSTAINED_DECLINE_WEEKS - 1, 'two low meaningful weeks recorded so far');
  const gapWeek = decideEmailGateFunnelAlerts({ impressions: 5, captured: 0, capturesPerWeek: 0 }, st, NOW + (SUSTAINED_DECLINE_WEEKS - 1) * 7 * DAY);
  assert.deepEqual(gapWeek.state.recentCaptures, [], 'a non-meaningful window must reset the rolling history, not leave it dangling');
  const third = decideEmailGateFunnelAlerts({ impressions: 100, captured: 2, capturesPerWeek: 2 }, gapWeek.state, NOW + SUSTAINED_DECLINE_WEEKS * 7 * DAY);
  assert.ok(!kinds(third).includes('sustained-decline'), 'low / low / gap / low is only 1 consecutive meaningful week after the reset, not 3');
  assert.equal(third.state.recentCaptures.length, 1);
});

test('sustained-decline does not fire if any recent week hit the hard collapse floor (capture-collapse already covers it)', () => {
  let st = {};
  const weeks = [2, 0.5, 2]; // middle week trips capture-collapse instead
  let last;
  for (const capturesPerWeek of weeks) {
    last = decideEmailGateFunnelAlerts({ impressions: 100, captured: capturesPerWeek, capturesPerWeek }, st, NOW + weeks.indexOf(capturesPerWeek) * 7 * DAY);
    st = last.state;
  }
  assert.ok(!kinds(last).includes('sustained-decline'));
});

test('sustained-decline does not fire on a healthy trend (captures at/above threshold)', () => {
  let st = {};
  let last;
  for (let i = 0; i < SUSTAINED_DECLINE_WEEKS; i++) {
    last = decideEmailGateFunnelAlerts({ impressions: 100, captured: 5, capturesPerWeek: 5 }, st, NOW + i * 7 * DAY);
    st = last.state;
  }
  assert.ok(!kinds(last).includes('sustained-decline'));
});

test('weekly summary is log-only (never email) and always present', () => {
  const r = decideEmailGateFunnelAlerts({ impressions: 100, captured: 5, capturesPerWeek: 5 }, {}, NOW);
  const weekly = r.alerts.find((a) => a.kind === 'weekly-summary');
  assert.ok(weekly);
  assert.equal(weekly.email, false);
  assert.equal(weekly.logOnly, true);
});
