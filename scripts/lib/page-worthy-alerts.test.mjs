import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { isPageWorthy } = createRequire(import.meta.url)('./page-worthy-alerts.js');

test('window-end ESCALATION from the opening-night monitor pages the owner (BRO-2791)', () => {
  assert.equal(isPageWorthy('on-monitor-escalation-on-monitor-2026-09-04'), true);
  assert.equal(isPageWorthy('on-monitor-escalation-on-monitor-forced-some-show'), true);
});

test('the success report and per-pass monitor noise stay in the digest', () => {
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-04'), false);
  assert.equal(isPageWorthy('on-monitor-attempts-exhausted-2026-09-04'), false);
  assert.equal(isPageWorthy('on-monitor-auth-starved-2026-09-04'), false);
});

test('the one FINAL per-show opening-night report pages; the base per-night key does not (BRO-4043)', () => {
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-21-show-a-parity-final'), true);
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-21-show-a-escalation-final'), true);
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-21'), false);
  assert.equal(isPageWorthy('on-monitor-report-on-monitor-2026-09-21-show-a-parity-final-retry'), false);
});

// --- BRO-5480: every page names what the OWNER does about it ---
const { OWNER_ACTIONS, AWAITING_OWNER_DECISION, allPageWorthyEntries } = createRequire(import.meta.url)('./page-worthy-alerts.js');

test('every page-worthy entry names the owner action, or is in the frozen awaiting-decision set', () => {
  const missing = allPageWorthyEntries().filter((e) => !(OWNER_ACTIONS[e] && OWNER_ACTIONS[e].trim()) && !AWAITING_OWNER_DECISION.has(e));
  assert.deepEqual(missing, [], 'Owner rule BRO-4603: email only when urgent AND the owner must act. Name the action in OWNER_ACTIONS, or route it to a worker card (disposition \'auto\') instead.');
});

test('no stale rows: every owner action and awaiting entry is a live page', () => {
  const live = new Set(allPageWorthyEntries());
  assert.deepEqual(Object.keys(OWNER_ACTIONS).filter((k) => !live.has(k)), []);
  assert.deepEqual([...AWAITING_OWNER_DECISION].filter((k) => !live.has(k)), []);
});

test('the awaiting-decision set may shrink but never grow (pinned)', () => {
  const PINNED = [
    'ugc-roundtrip:users-affected', 'serp-burst:tripwire',
    'guard-escalation:stale-checkout-staleness', 'guard-escalation:scoring-queue-scan-failed',
    'guard-escalation:ensemble-scoring-pipeline-crashed', 'guard-escalation:review-count-drift-strict-breach',
    'on-monitor-launch-failed-', 'on-monitor-auth-starved-sustained-', 'on-monitor-escalation-',
    'on-monitor-dead-session-', 'on-monitor-report-*-final', 'broadcast:overdue:', 'broadcast:never-sent:',
    'ugc:signin-redirect-broken:', 'opening-night-orchestrator.yml', 'opening-night-poller.yml',
  ];
  const extra = [...AWAITING_OWNER_DECISION].filter((k) => !PINNED.includes(k));
  assert.deepEqual(extra, [], 'a new page must name the owner action; it cannot join the awaiting set');
});

test('stuck opening-night reviews never email the owner (BRO-5480)', () => {
  assert.equal(isPageWorthy('opening-night-sla:pages-stuck'), false);
});
