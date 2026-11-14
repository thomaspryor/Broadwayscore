import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { summarizeGatePageViews, getGatePageViewSummary } = require('../../scripts/lib/gate-modal-guardrail.js');
const { decideEmailGateFunnelAlerts } = require('../../scripts/lib/email-gate-funnel-rules.js');
const { REAL_USERS_WHERE } = require('../../scripts/lib/posthog-query.js');

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const summarize = (...rows) => summarizeGatePageViews(rows);
const decide = (pageViewGuardrail, state = {}, now = NOW) =>
  decideEmailGateFunnelAlerts({ impressions: 1, captured: 0, pageViewGuardrail }, state, now);
const violationAlert = result => result.alerts.find(a => a.kind === 'page-view-minimum');

test('counts events below the minimum, including zero; allows the exact boundary', () => {
  assert.deepEqual(summarize(
    ['exit_intent', '0', '2', 1],
    ['scroll_depth', '1', '2', 2],
    ['return_visitor', '2', '2', 3],
    ['exit_intent', '5', '2', 4],
  ), {
    checkedEvents: 10, belowMinimumEvents: 3, unknownPageViewEvents: 0, exemptEvents: 0,
    violationsByTrigger: { exit_intent: 1, scroll_depth: 2 },
  });
});

test('missing, null, malformed, and nonnumeric historical telemetry never becomes zero', () => {
  for (const raw of ['', 'null', '""', '"1"', 'true', '{}', '[]', 'garbage', '-1', '1.5']) {
    const summary = summarize(['exit_intent', raw, '2', 7]);
    assert.equal(summary.unknownPageViewEvents, 7, raw);
    assert.equal(summary.belowMinimumEvents, 0, raw);
    assert.equal(violationAlert(decide(summary)), undefined, raw);
  }
});

test('respects a higher configured minimum but cannot lower the invariant below two', () => {
  assert.equal(summarize(['scroll_depth', '2', '3', 1]).belowMinimumEvents, 1);
  for (const min of ['1', '0', '', 'null', '"2"', 'oops']) {
    assert.equal(summarize(['exit_intent', '1', min, 1]).belowMinimumEvents, 1, min);
  }
  assert.equal(summarize(['scroll_depth', '3', '3', 1]).belowMinimumEvents, 0);
});

test('explicit actions, blocking gates and recapture are exempt; passive triggers are checked', () => {
  for (const [trigger, violations, exempt] of [
    ['exit_intent', 1, 0], ['scroll_depth', 1, 0], ['return_visitor', 1, 0],
    ['page_view_limit', 0, 1], ['csv_download', 0, 1], ['json_download', 0, 1],
    ['recapture', 0, 1], ['future_passive_trigger', 1, 0],
  ]) {
    const summary = summarize([trigger, '1', '2', 1]);
    assert.equal(summary.belowMinimumEvents, violations, trigger);
    assert.equal(summary.exemptEvents, exempt, trigger);
  }
});

test('one violation alerts even during ramp-up, with an independent retryable cooldown', () => {
  const summary = summarize(['exit_intent', '1', '2', 1]);
  const first = decide(summary, { lastCollapseAlertAt: NOW, lastStalledAlertAt: NOW });
  const alert = violationAlert(first);
  assert.ok(alert);
  assert.equal(alert.email, true);
  assert.equal(alert.severity, 'error');
  assert.equal(first.state[alert.stampKey], NOW);
  assert.match(alert.description, /1.*gate_modal_shown/);
  assert.match(alert.description, /exit_intent/);
  assert.equal(violationAlert(decide(summary, first.state, NOW + DAY)), undefined);
  assert.ok(violationAlert(decide(summary, first.state, NOW + 6 * DAY)));
  const failedDeliveryState = { ...first.state };
  delete failedDeliveryState[alert.stampKey];
  assert.ok(violationAlert(decide(summary, failedDeliveryState, NOW + DAY)));
});

test('healthy, empty and pre-instrumentation summaries do not raise the invariant alert', () => {
  for (const summary of [undefined, summarize(), summarize(['exit_intent', '2', '2', 12])]) {
    assert.equal(violationAlert(decide(summary)), undefined);
  }
});

test('the production query keeps the window and real-user lens and summarizes grouped events', async () => {
  let calls = 0;
  const result = await getGatePageViewSummary(7, async sql => {
    calls++;
    assert.match(sql, /event = 'gate_modal_shown'/);
    assert.ok(sql.includes(REAL_USERS_WHERE));
    assert.match(sql, /INTERVAL 7 DAY/);
    assert.match(sql, /JSONExtractRaw\(properties,\s*'pageViewCount'\)/);
    assert.match(sql, /JSONExtractRaw\(properties,\s*'minPageViewsForPassiveGate'\)/);
    assert.match(sql, /GROUP BY trigger, pageViewCount, minPageViewsForPassiveGate/);
    assert.match(sql, /LIMIT 1000000/);
    return [['scroll_depth', '1', '2', '2'], ['scroll_depth', '2', '2', '8']];
  });
  assert.equal(calls, 1);
  assert.equal(result.checkedEvents, 10);
  assert.equal(result.belowMinimumEvents, 2);
});

test('query failures propagate instead of producing a false healthy result', async () => {
  await assert.rejects(getGatePageViewSummary(7, async () => { throw new Error('unavailable'); }), /unavailable/);
});

test('the event writer stamps the fire-time count on normal and recapture openings', () => {
  const context = readFileSync(new URL('../../src/contexts/ProGateContext.tsx', import.meta.url), 'utf8');
  const modal = readFileSync(new URL('../../src/components/EmailCaptureModal.tsx', import.meta.url), 'utf8');
  const openings = [...context.matchAll(/setGateFireMeta\(\{([\s\S]*?)\}\);[\s\S]*?setModalOpen\(true\)/g)];
  assert.equal(openings.length, 2, 'both opening paths must snapshot their own telemetry');
  for (const [, props] of openings) {
    assert.match(props, /pageViewCount:\s*sessionPageViewsRef\.current/);
    assert.match(props, /minPageViewsForPassiveGate:\s*emailCaptureConfig\.minPageViewsForPassiveGate/);
  }
  assert.match(context, /analyticsProps=\{gateFireMeta\}/);
  for (const method of ['track', 'captureEvent']) {
    assert.match(modal, new RegExp(`${method}\\('gate_modal_shown', \\{[^}]*\\.\\.\\.analyticsProps`));
  }
});
