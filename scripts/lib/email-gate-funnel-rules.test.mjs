import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decideEmailGateFunnelAlerts, ALERT_JOINS_PER_WEEK, BASELINE_JOINS_PER_WEEK, MIN_IMPRESSIONS_FOR_ALERT,
  SUSTAINED_DECLINE_WEEKS, SUSTAINED_DECLINE_THRESHOLD,
} = require('./email-gate-funnel-rules.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const kinds = (r) => r.alerts.map((a) => a.kind);
const EMAIL_KINDS = ['joins-collapse', 'sustained-decline', 'funnel-stalled', 'joins-unknown', 'page-view-minimum', 'auth-joins-stalled', 'auth-joins-unknown'];
const emailed = (r) => r.alerts.filter((a) => a.email).map((a) => a.kind);
// A week shaped like the real Oct 2026 weeks: modal ~3, inline a few, most joins from sign-in.
const week = (o = {}) => ({
  impressions: 380, captured: 3, capturesPerWeek: 3, inlineCaptures: 5, signIns: 25, formspreeAuthJoins: 25, totalJoins: 32, totalJoinsPerWeek: 32, ...o,
});

test('BRO-6371 regression: a zero modal-only week with healthy total joins does NOT alert', () => {
  // The exact week that fired the false CRITICAL on 2026-10-26: 386 impressions, 0 modal captures.
  const r = decideEmailGateFunnelAlerts(week({ impressions: 386, captured: 0, capturesPerWeek: 0 }),
    { everReachedFloor: true, recentCaptures: [3, 3, 0] }, NOW);
  assert.deepEqual(emailed(r), [], 'no email alert may fire');
  assert.ok(kinds(r).includes('modal-captures'), 'modal-only stays visible as a log line');
  assert.equal(r.alerts.find((a) => a.kind === 'modal-captures').logOnly, true);
});

test('a true collapse of total joins still alerts', () => {
  const r = decideEmailGateFunnelAlerts(week({ captured: 0, capturesPerWeek: 0, inlineCaptures: 1, signIns: 2, totalJoins: 3, totalJoinsPerWeek: 3 }), {}, NOW);
  const alert = r.alerts.find((a) => a.kind === 'joins-collapse');
  assert.ok(alert, 'collapse alert must fire');
  assert.equal(alert.email, true);
  assert.equal(alert.severity, 'error');
  assert.equal(alert.stampKey, 'lastCollapseAlertAt', 'keeps the old stamp key so existing state cools down correctly');
  assert.equal(r.state.lastCollapseAlertAt, NOW);
  assert.match(alert.description, /sign-ins 2/);
});

test('collapse fires even when modal impressions are healthy and modal captures look fine', () => {
  // Sign-in tracking broke; modal is untouched. Modal-only would never see it.
  const r = decideEmailGateFunnelAlerts(week({ signIns: 0, inlineCaptures: 0, totalJoins: 4, totalJoinsPerWeek: 4, captured: 4, capturesPerWeek: 4 }), {}, NOW);
  assert.ok(kinds(r).includes('joins-collapse'));
});

test('alert copy drops the revert-the-gate advice and the dead claude-outputs path', () => {
  const r = decideEmailGateFunnelAlerts(week({ totalJoins: 0, totalJoinsPerWeek: 0 }), {}, NOW);
  for (const a of r.alerts) {
    assert.doesNotMatch(a.description, /consider reverting/i, `${a.kind} must not advise reverting the gate`);
    assert.doesNotMatch(a.description, /claude-outputs/, `${a.kind} must not cite a Mac-only path`);
  }
  assert.match(r.alerts.find((a) => a.kind === 'joins-collapse').description, /docs\/experiments\/gate-cold-start\.md/);
});

test('collapse threshold is exclusive at the boundary', () => {
  const atFloor = decideEmailGateFunnelAlerts(week({ totalJoins: ALERT_JOINS_PER_WEEK, totalJoinsPerWeek: ALERT_JOINS_PER_WEEK }), {}, NOW);
  assert.ok(!kinds(atFloor).includes('joins-collapse'), 'exactly at the floor is not a collapse');
  const below = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: ALERT_JOINS_PER_WEEK - 0.01 }), {}, NOW);
  assert.ok(kinds(below).includes('joins-collapse'));
});

test('totalJoins is used when totalJoinsPerWeek is missing', () => {
  const r = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: undefined, totalJoins: 2 }), {}, NOW);
  assert.ok(kinds(r).includes('joins-collapse'));
});

test('re-based baseline sits above the floor and the decline threshold', () => {
  assert.ok(BASELINE_JOINS_PER_WEEK > SUSTAINED_DECLINE_THRESHOLD);
  assert.ok(SUSTAINED_DECLINE_THRESHOLD > ALERT_JOINS_PER_WEEK);
  // Every real post-accounts week (25, 32, 48) must be silent.
  for (const n of [25, 32, 48]) {
    const r = decideEmailGateFunnelAlerts(week({ totalJoins: n, totalJoinsPerWeek: n }), {}, NOW);
    assert.deepEqual(emailed(r), [], `${n} joins/wk must not alert`);
  }
});

test('missing totals on a live funnel fire joins-unknown, never a modal-only judgment', () => {
  const r = decideEmailGateFunnelAlerts({ impressions: 380, captured: 0, capturesPerWeek: 0 }, {}, NOW);
  assert.ok(kinds(r).includes('joins-unknown'));
  assert.ok(!kinds(r).includes('joins-collapse'));
  const again = decideEmailGateFunnelAlerts({ impressions: 380, captured: 0 }, r.state, NOW + DAY);
  assert.ok(!kinds(again).includes('joins-unknown'), 'cooldown applies');
});

test('delivery-retry contract: reverting the stamp makes the alert fire again', () => {
  const first = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: 2 }), {}, NOW);
  const st = { ...first.state };
  delete st.lastCollapseAlertAt;
  const retry = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: 2 }), st, NOW + DAY);
  assert.ok(kinds(retry).includes('joins-collapse'));
});

test('cooldown: same-week re-run does not double-alert, but a later week does', () => {
  const first = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: 2 }), {}, NOW);
  const sameWeek = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: 2 }), first.state, NOW + DAY);
  assert.ok(!kinds(sameWeek).includes('joins-collapse'));
  const nextWeek = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: 2 }), sameWeek.state, NOW + 7 * DAY);
  assert.ok(kinds(nextWeek).includes('joins-collapse'));
});

test('existing state cools down from its old lastCollapseAlertAt stamp', () => {
  const r = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: 2 }), { everReachedFloor: true, lastCollapseAlertAt: NOW - DAY }, NOW);
  assert.ok(!kinds(r).includes('joins-collapse'));
});

test('state migration: legacy modal-only recentCaptures is dropped, recentJoins starts fresh', () => {
  const r = decideEmailGateFunnelAlerts(week(), { everReachedFloor: true, recentCaptures: [3, 3, 0] }, NOW);
  assert.equal(r.state.recentCaptures, undefined);
  assert.deepEqual(r.state.recentJoins, [32]);
  assert.equal(r.state.everReachedFloor, true);
});

test('ramp-up: gate never reached the impression floor → modal logged as ramp-up, healthy joins silent', () => {
  const r = decideEmailGateFunnelAlerts(week({ impressions: 21 }), {}, NOW);
  assert.ok(kinds(r).includes('ramp-up'));
  assert.deepEqual(emailed(r), []);
  assert.equal(r.state.everReachedFloor, undefined);
});

test('joins are judged even with a reset state file and a broken modal (sign-ins do not depend on it)', () => {
  const r = decideEmailGateFunnelAlerts(week({ impressions: 0, totalJoinsPerWeek: 1 }), {}, NOW);
  assert.ok(kinds(r).includes('joins-collapse'));
});

test('funnel-stalled: impressions that reached the floor then collapse fire an actionable alert', () => {
  const healthy = decideEmailGateFunnelAlerts(week(), {}, NOW);
  assert.equal(healthy.state.everReachedFloor, true);
  const stalled = decideEmailGateFunnelAlerts(week({ impressions: 5 }), healthy.state, NOW + 7 * DAY);
  assert.ok(kinds(stalled).includes('funnel-stalled'));
  assert.ok(!kinds(stalled).includes('ramp-up'));
  assert.ok(!kinds(stalled).includes('joins-collapse'), 'joins are still healthy, so only the modal stall alerts');
  const again = decideEmailGateFunnelAlerts(week({ impressions: 5 }), stalled.state, NOW + 8 * DAY);
  assert.ok(!kinds(again).includes('funnel-stalled'), 'own cooldown');
  const later = decideEmailGateFunnelAlerts(week({ impressions: 5 }), again.state, NOW + 14 * DAY);
  assert.ok(kinds(later).includes('funnel-stalled'));
});

test('a modal stall does not hide a joins collapse (sign-ins do not depend on the modal)', () => {
  const r = decideEmailGateFunnelAlerts(week({ impressions: 0, totalJoinsPerWeek: 1 }), { everReachedFloor: true }, NOW);
  assert.ok(kinds(r).includes('funnel-stalled'));
  assert.ok(kinds(r).includes('joins-collapse'));
});

test(`sustained-decline: ${SUSTAINED_DECLINE_WEEKS} weeks under ${SUSTAINED_DECLINE_THRESHOLD}/wk but above the floor fires once`, () => {
  let st = {};
  let last;
  for (let i = 0; i < SUSTAINED_DECLINE_WEEKS; i++) {
    last = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: 12 }), st, NOW + i * 7 * DAY);
    st = last.state;
    if (i < SUSTAINED_DECLINE_WEEKS - 1) assert.ok(!kinds(last).includes('sustained-decline'));
  }
  assert.ok(kinds(last).includes('sustained-decline'));
  assert.deepEqual(st.recentJoins, Array(SUSTAINED_DECLINE_WEEKS).fill(12));
});

test('sustained-decline history resets across an unjudged week', () => {
  let st = {};
  for (let i = 0; i < SUSTAINED_DECLINE_WEEKS - 1; i++) st = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: 12 }), st, NOW + i * 7 * DAY).state;
  const gap = decideEmailGateFunnelAlerts({ impressions: 380 }, st, NOW + 14 * DAY);
  assert.deepEqual(gap.state.recentJoins, []);
  const after = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: 12 }), gap.state, NOW + 21 * DAY);
  assert.ok(!kinds(after).includes('sustained-decline'));
});

test('sustained-decline does not fire on a healthy trend or when a week hit the hard floor', () => {
  let st = {};
  let last;
  for (let i = 0; i < SUSTAINED_DECLINE_WEEKS; i++) {
    last = decideEmailGateFunnelAlerts(week(), st, NOW + i * 7 * DAY);
    st = last.state;
  }
  assert.ok(!kinds(last).includes('sustained-decline'));
  st = {};
  for (const [i, n] of [12, 5, 12].entries()) {
    last = decideEmailGateFunnelAlerts(week({ totalJoinsPerWeek: n }), st, NOW + i * 7 * DAY);
    st = last.state;
  }
  assert.ok(!kinds(last).includes('sustained-decline'));
});

test('weekly summary is log-only, always present, and shows sign-ins and total joins', () => {
  const r = decideEmailGateFunnelAlerts(week(), {}, NOW);
  const weekly = r.alerts.find((a) => a.kind === 'weekly-summary');
  assert.equal(weekly.email, false);
  assert.equal(weekly.logOnly, true);
  assert.match(weekly.description, /total joins\/wk 32/);
  assert.match(weekly.description, /account sign-ins 25/);
  for (const a of r.alerts) if (a.email) assert.ok(EMAIL_KINDS.includes(a.kind));
});

test('page-view-minimum guardrail is unchanged', () => {
  const r = decideEmailGateFunnelAlerts(week({ pageViewGuardrail: { belowMinimumEvents: 2, checkedEvents: 10, unknownPageViewEvents: 0, violationsByTrigger: { exit_intent: 2 } } }), {}, NOW);
  assert.ok(kinds(r).includes('page-view-minimum'));
  assert.ok(MIN_IMPRESSIONS_FOR_ALERT > 0);
});

test('BRO-6372: 30 sign-ins with zero confirmed Formspree auth joins email an alert', () => {
  const r = decideEmailGateFunnelAlerts(week({ signIns: 30, formspreeAuthJoins: 0 }), {}, NOW);
  const alert = r.alerts.find((a) => a.kind === 'auth-joins-stalled');
  assert.ok(alert, 'successful sign-in events cannot prove Formspree accepted subscriptions');
  assert.equal(alert.email, true);
  assert.equal(alert.severity, 'error');
  assert.equal(r.state[alert.stampKey], NOW);
});

test('Formspree auth alert includes the 10-sign-in boundary and works without modal impressions', () => {
  for (const signIns of [0, 9, 10, 30]) {
    const r = decideEmailGateFunnelAlerts(week({ impressions: 0, signIns, formspreeAuthJoins: 0 }), {}, NOW);
    assert.equal(kinds(r).includes('auth-joins-stalled'), signIns >= 10, `${signIns} sign-ins`);
  }
  assert.deepEqual(emailed(decideEmailGateFunnelAlerts(week({ formspreeAuthJoins: 1 }), {}, NOW)), []);
});

test('missing or failed Formspree verification alerts as unknown, never as zero submissions', () => {
  for (const formspreeAuthJoins of [undefined, null, NaN, -1, '0']) {
    const r = decideEmailGateFunnelAlerts(week({ formspreeAuthJoins, formspreeAuthJoinsStatus: 'unavailable' }), {}, NOW);
    assert.deepEqual(emailed(r), ['auth-joins-unknown']);
    assert.match(r.alerts.find((a) => a.kind === 'auth-joins-unknown').description, /unavailable/);
  }
});

test('Formspree alerts have independent cooldowns and delivery-retry stamps', () => {
  const summary = week({ formspreeAuthJoins: 0 });
  const first = decideEmailGateFunnelAlerts(summary, { lastCollapseAlertAt: NOW }, NOW);
  const alert = first.alerts.find((a) => a.kind === 'auth-joins-stalled');
  assert.ok(alert, 'a total-joins alert cannot silence the delivery check');
  assert.deepEqual(emailed(decideEmailGateFunnelAlerts(summary, first.state, NOW + DAY)), []);
  assert.ok(kinds(decideEmailGateFunnelAlerts(summary, first.state, NOW + 7 * DAY)).includes(alert.kind));
  const retryState = { ...first.state };
  delete retryState[alert.stampKey];
  assert.ok(kinds(decideEmailGateFunnelAlerts(summary, retryState, NOW + DAY)).includes(alert.kind));

  const unknownSummary = week({ formspreeAuthJoins: null });
  const unknown = decideEmailGateFunnelAlerts(unknownSummary, first.state, NOW + DAY);
  const unknownAlert = unknown.alerts.find((a) => a.kind === 'auth-joins-unknown');
  assert.ok(unknownAlert, 'API unavailability has its own cooldown');
  assert.equal(unknown.state[unknownAlert.stampKey], NOW + DAY);
  assert.deepEqual(emailed(decideEmailGateFunnelAlerts(unknownSummary, unknown.state, NOW + 2 * DAY)), []);
  assert.ok(kinds(decideEmailGateFunnelAlerts(unknownSummary, unknown.state, NOW + 8 * DAY)).includes(unknownAlert.kind));
});

test('weekly summary logs confirmed Formspree submissions or unknown', () => {
  for (const formspreeAuthJoins of [0, 20, null]) {
    const r = decideEmailGateFunnelAlerts(week({ formspreeAuthJoins }), {}, NOW);
    const log = r.alerts.find((a) => a.kind === 'weekly-summary');
    assert.ok(log.logOnly);
    assert.ok(log.description.includes(`Formspree auth-auto submissions ${formspreeAuthJoins ?? 'unknown'}`));
  }
});
