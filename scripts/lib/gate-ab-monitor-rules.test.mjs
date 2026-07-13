import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideGateAlerts, POWER_FLOOR, DURATION_MS } = require('./gate-ab-monitor-rules.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const mkSummary = (control, eoc, extra = {}) => ({
  tagged: true,
  arms: {
    control: { shown: control.shown ?? 0, dismissed: control.dismissed ?? 0, captured: 0 },
    'end-of-content': { shown: eoc.shown ?? 0, dismissed: eoc.dismissed ?? 0, captured: 0 },
    fallback: { shown: 5, dismissed: 5, captured: 0 },
  },
  mobileBouncePct: 64.15,
  ...extra,
});
// windows shape: arm counts live in CUMULATIVE; bounce guardrail reads RECENT.
const sum = (control, eoc, extra = {}) => ({
  cumulative: mkSummary(control, eoc),
  recent: mkSummary({ shown: Math.min(control.shown ?? 0, 50) }, { shown: Math.min(eoc.shown ?? 0, 50) }, extra),
});
const kinds = (r) => r.alerts.map((a) => a.kind);

test('pre-flag / fallback-only traffic: silent, but bounce baseline keeps rolling', () => {
  const r = decideGateAlerts({
    cumulative: { tagged: true, arms: { fallback: { shown: 40, dismissed: 40 } } },
    recent: { tagged: true, arms: { fallback: { shown: 10, dismissed: 10 } }, mobileBouncePct: 63.2 },
  }, {}, NOW);
  assert.deepEqual(r.alerts, []);
  assert.equal(r.state.baselineBouncePct, 63.2);
  assert.equal(r.state.startedAt, undefined);
});

test('first real-arm impressions: experiment-live email fires once, baseline frozen', () => {
  const r1 = decideGateAlerts(sum({ shown: 12 }, { shown: 9 }), { baselineBouncePct: 63.2 }, NOW);
  assert.ok(kinds(r1).includes('experiment-live'));
  assert.equal(r1.state.startedAt, NOW);
  assert.equal(r1.state.liveAlertedAt, NOW, 'delivery stamp separate from factual startedAt');
  assert.equal(r1.state.baselineBouncePct, 63.2, 'pre-launch baseline is kept, not overwritten');
  const r2 = decideGateAlerts(sum({ shown: 40 }, { shown: 38 }), r1.state, NOW + DAY);
  assert.ok(!kinds(r2).includes('experiment-live'), 'live alert is once-only');
});

test('delivery-retry contract: every emailed alert carries a stampKey the runner can revert', () => {
  const live = decideGateAlerts(sum({ shown: 12 }, { shown: 9 }), {}, NOW);
  for (const a of live.alerts.filter((x) => x.email)) {
    assert.ok(a.stampKey, a.kind + ' must carry stampKey');
    assert.ok(live.state[a.stampKey], 'stamp ' + a.stampKey + ' set in state');
  }
  // reverting the stamp makes the alert fire again (what the runner does on failed delivery)
  const st = { ...live.state }; delete st.liveAlertedAt;
  const retry = decideGateAlerts(sum({ shown: 20 }, { shown: 18 }), st, NOW + DAY);
  assert.ok(kinds(retry).includes('experiment-live'), 'reverted stamp → alert retries');
});

test('stalled: started experiment with zero real-arm impressions → email + baseline NOT overwritten', () => {
  const windows = {
    cumulative: { tagged: true, arms: { fallback: { shown: 30, dismissed: 30 } } },
    recent: { tagged: true, arms: { fallback: { shown: 8, dismissed: 8 } }, mobileBouncePct: 71.0 },
  };
  const r = decideGateAlerts(windows, { startedAt: NOW, baselineBouncePct: 64 }, NOW + 10 * DAY);
  assert.ok(kinds(r).includes('experiment-stalled'));
  assert.equal(r.state.baselineBouncePct, 64, 'in-experiment dead week must not overwrite the baseline');
  const cooled = decideGateAlerts(windows, r.state, NOW + 12 * DAY);
  assert.ok(!kinds(cooled).includes('experiment-stalled'), '7d cooldown');
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
  assert.equal(weekly.logOnly, true, 'honest: no Discord exists, this is log-only');
  assert.notEqual(weekly.severity, 'error', 'must stay below the emailable-severity line');
});

test('REGRESSION: power floor is judged on CUMULATIVE counts, not the 7-day window (unit-mismatch bug, 2026-07-13)', () => {
  // Realistic week 6: only ~170/arm shown in the last 7 days, but the
  // whole-experiment counts are past the floor. power-reached MUST fire.
  const windows = {
    cumulative: mkSummary({ shown: POWER_FLOOR + 10 }, { shown: POWER_FLOOR + 5 }),
    recent: mkSummary({ shown: 170 }, { shown: 165 }, { mobileBouncePct: 64.2 }),
  };
  const r = decideGateAlerts(windows, { startedAt: NOW, baselineBouncePct: 64 }, NOW + 40 * DAY);
  assert.ok(r.alerts.some((a) => a.kind === 'power-reached'),
    'cumulative counts past floor must trigger power-reached even when the weekly window is small');
});
