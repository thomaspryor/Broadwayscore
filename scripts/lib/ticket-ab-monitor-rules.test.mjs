import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideTicketAbAlerts, COOLDOWN_MS, MIN_CLICKS_FOR_DATA_PROBLEM } = require('./ticket-ab-monitor-rules.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const kinds = (r) => r.alerts.map((a) => a.kind);

function healthySummary(overrides = {}) {
  return {
    flag: 'ticket-single-button',
    days: 14,
    flagHealthy: true,
    flagHealthProblem: null,
    variants: [
      { name: 'multi', clicks: 109, users: 41, convUsers: 9, convCount: 10, joinCoverage: 1 },
      { name: 'single', clicks: 148, users: 51, convUsers: 18, convCount: 40, joinCoverage: 1 },
    ],
    primary: { p: 0.1624, significant: false, suppressed: null, degenerate: null, underpowered: false, underpoweredNote: null },
    ...overrides,
  };
}

test('healthy week, not significant: no actionable alerts, only weekly-summary', () => {
  const r = decideTicketAbAlerts(healthySummary(), {}, NOW);
  assert.deepEqual(kinds(r), ['weekly-summary']);
});

test('degenerate primary (e.g. NaN-class bug reappearing) fires primary-data-problem', () => {
  const r = decideTicketAbAlerts(
    healthySummary({ primary: { p: null, significant: null, suppressed: null, degenerate: 'group a has n=0 (no trials)', underpowered: false } }),
    {}, NOW);
  const alert = r.alerts.find(a => a.kind === 'primary-data-problem');
  assert.ok(alert);
  assert.equal(alert.email, true);
  assert.equal(alert.severity, 'error');
  assert.ok(alert.description.includes('group a has n=0'));
  assert.ok(alert.stampKey);
});

test('suppressed primary (flag drift, join-coverage gap, etc.) fires primary-data-problem, includes flag health text when unhealthy', () => {
  const r = decideTicketAbAlerts(
    healthySummary({
      flagHealthy: false,
      flagHealthProblem: 'variant split drifted',
      primary: { p: null, significant: null, suppressed: 'flag state does not match registry expectations', degenerate: null, underpowered: false },
    }),
    {}, NOW);
  const alert = r.alerts.find(a => a.kind === 'primary-data-problem');
  assert.ok(alert);
  assert.ok(alert.description.includes('flag state does not match registry expectations'));
  assert.ok(alert.description.includes('variant split drifted'));
});

test('primary-data-problem respects cooldown: same-week re-run does not double-alert, later week does', () => {
  const broken = healthySummary({ primary: { p: null, significant: null, suppressed: 'join coverage below 90%', degenerate: null, underpowered: false } });
  const first = decideTicketAbAlerts(broken, {}, NOW);
  const sameWeek = decideTicketAbAlerts(broken, first.state, NOW + DAY);
  assert.ok(!kinds(sameWeek).includes('primary-data-problem'), 'inside cooldown');
  const nextWeek = decideTicketAbAlerts(broken, sameWeek.state, NOW + 7 * DAY);
  assert.ok(kinds(nextWeek).includes('primary-data-problem'), 'still broken after cooldown clears → re-alerts');
});

test('delivery-retry contract: reverting the stamp makes primary-data-problem fire again mid-cooldown', () => {
  const broken = healthySummary({ primary: { p: null, significant: null, suppressed: 'join coverage below 90%', degenerate: null, underpowered: false } });
  const week1 = decideTicketAbAlerts(broken, {}, NOW);
  const stampKey = week1.alerts.find(a => a.kind === 'primary-data-problem').stampKey;
  const st = { ...week1.state };
  delete st[stampKey];
  const retry = decideTicketAbAlerts(broken, st, NOW + DAY);
  assert.ok(kinds(retry).includes('primary-data-problem'), 'reverted stamp → alert retries even mid-cooldown window');
});

test('significance-reached fires when p < 0.05 and not underpowered', () => {
  const r = decideTicketAbAlerts(
    healthySummary({ primary: { p: 0.021, significant: true, suppressed: null, degenerate: null, underpowered: false } }),
    {}, NOW);
  const alert = r.alerts.find(a => a.kind === 'significance-reached');
  assert.ok(alert);
  assert.equal(alert.email, true);
  assert.ok(alert.description.includes('0.0210'));
  assert.ok(alert.stampKey);
});

test('significance-reached does NOT fire while underpowered, even if significant', () => {
  const r = decideTicketAbAlerts(
    healthySummary({ primary: { p: 0.03, significant: true, suppressed: null, degenerate: null, underpowered: true, underpoweredNote: 'min 20 clicks/variant' } }),
    {}, NOW);
  assert.ok(!kinds(r).includes('significance-reached'));
});

test('significance-reached fires only once — a later still-significant week must not re-alert', () => {
  const sig = healthySummary({ primary: { p: 0.01, significant: true, suppressed: null, degenerate: null, underpowered: false } });
  const first = decideTicketAbAlerts(sig, {}, NOW);
  assert.ok(kinds(first).includes('significance-reached'));
  const later = decideTicketAbAlerts(sig, first.state, NOW + 30 * DAY);
  assert.ok(!kinds(later).includes('significance-reached'), 'never judges the winner twice — one nudge only');
});

test('significance-reached never fires while a data problem is present, even if significant flag is stale-true', () => {
  const r = decideTicketAbAlerts(
    healthySummary({ primary: { p: 0.01, significant: true, suppressed: 'cross-variant leakage', degenerate: null, underpowered: false } }),
    {}, NOW);
  assert.ok(!kinds(r).includes('significance-reached'));
  assert.ok(kinds(r).includes('primary-data-problem'));
});

test('weekly-summary is log-only (never email) and always present, even alongside actionable alerts', () => {
  const r = decideTicketAbAlerts(
    healthySummary({ primary: { p: null, significant: null, suppressed: 'flag unhealthy', degenerate: null, underpowered: false } }),
    {}, NOW);
  const weekly = r.alerts.find(a => a.kind === 'weekly-summary');
  assert.ok(weekly);
  assert.equal(weekly.email, false);
  assert.equal(weekly.logOnly, true);
  assert.ok(weekly.description.includes('data problem'));
});

test(`degenerate primary during ramp-up (combined clicks < ${MIN_CLICKS_FOR_DATA_PROBLEM}) does NOT alert — it's ramp-up, not breakage`, () => {
  const r = decideTicketAbAlerts(
    healthySummary({
      variants: [
        { name: 'multi', clicks: 5, users: 3, convUsers: 0, convCount: 0, joinCoverage: null },
        { name: 'single', clicks: 4, users: 2, convUsers: 0, convCount: 0, joinCoverage: null },
      ],
      primary: { p: null, significant: null, suppressed: null, degenerate: 'need exactly 2 variants, got 1', underpowered: false },
    }),
    {}, NOW);
  assert.ok(!kinds(r).includes('primary-data-problem'), 'near-empty window must not read as a pipeline break');
  const weekly = r.alerts.find(a => a.kind === 'weekly-summary');
  assert.ok(weekly.description.includes('ramp-up'));
});

test('suppressed primary (never traffic-dependent) still alerts even during a low-traffic window', () => {
  const r = decideTicketAbAlerts(
    healthySummary({
      variants: [
        { name: 'multi', clicks: 5, users: 3, convUsers: 0, convCount: 0, joinCoverage: null },
        { name: 'single', clicks: 4, users: 2, convUsers: 0, convCount: 0, joinCoverage: null },
      ],
      primary: { p: null, significant: null, suppressed: 'flag state does not match registry expectations', degenerate: null, underpowered: false },
    }),
    {}, NOW);
  assert.ok(kinds(r).includes('primary-data-problem'), 'suppressed reasons (flag drift, join gap, leakage) alert regardless of volume');
});

test('significance-reached surfaces primary.note (e.g. asymmetric-zero-conversions caution) as a caveat', () => {
  const r = decideTicketAbAlerts(
    healthySummary({
      primary: {
        p: 0.01, significant: true, suppressed: null, degenerate: null, underpowered: false,
        note: "arm 'multi' has 0 attributed conversions while 'single' has 40 at comparable click volume — verify the SubId postback pipeline",
      },
    }),
    {}, NOW);
  const alert = r.alerts.find(a => a.kind === 'significance-reached');
  assert.ok(alert);
  assert.ok(alert.description.includes('verify the SubId postback pipeline'), 'the caution must ride along, not get silently dropped');
});

test(`primary-data-problem cooldown is ${COOLDOWN_MS / DAY} days`, () => {
  assert.equal(COOLDOWN_MS, 6 * DAY);
});
