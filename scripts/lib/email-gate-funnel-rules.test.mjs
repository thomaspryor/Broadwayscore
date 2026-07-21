import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideEmailGateFunnelAlerts, ALERT_CAPTURES_PER_WEEK, MIN_IMPRESSIONS_FOR_ALERT } = require('./email-gate-funnel-rules.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const kinds = (r) => r.alerts.map((a) => a.kind);

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

test('weekly summary is log-only (never email) and always present', () => {
  const r = decideEmailGateFunnelAlerts({ impressions: 100, captured: 5, capturesPerWeek: 5 }, {}, NOW);
  const weekly = r.alerts.find((a) => a.kind === 'weekly-summary');
  assert.ok(weekly);
  assert.equal(weekly.email, false);
  assert.equal(weekly.logOnly, true);
});
