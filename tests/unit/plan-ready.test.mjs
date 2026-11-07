// Guards the plan-ready auto-escalation predicate (scripts/lib/plan-ready.js),
// used by notion-action-poll.js after an action completes. Bug class: a
// Plan-only action left card 3a4637c5 at "Not started"/no-priority — invisible
// to every dispatch path — for 10 days (2026-07-31).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PLAN_ONLY_ACTIONS, shouldMarkPlanReady } = require('../../scripts/lib/plan-ready.js');

test('plan-only actions on a priority-less Not-started card escalate', () => {
  for (const action of ['Plan', 'Investigate', 'Review', 'Plan+Review']) {
    assert.equal(shouldMarkPlanReady({ action, priority: null, status: 'Not started' }), true, action);
  }
});

test('implementing actions never escalate — they ship the code themselves', () => {
  for (const action of ['Fix', 'Start']) {
    assert.equal(shouldMarkPlanReady({ action, priority: null, status: 'Not started' }), false, action);
  }
});

test('owner-set priority is always respected (no overwrite, no comment spam)', () => {
  for (const priority of ['P0 Now', 'P1 Next', 'P2']) {
    assert.equal(shouldMarkPlanReady({ action: 'Plan', priority, status: 'Not started' }), false, priority);
  }
});

test('only Not-started cards escalate — owned/closed/parked cards are left alone', () => {
  for (const status of ['In progress', 'Done', 'Paused', 'Unknown', undefined]) {
    assert.equal(shouldMarkPlanReady({ action: 'Plan', priority: null, status }), false, String(status));
  }
});

test('unknown/empty actions are ignored (fail closed)', () => {
  assert.equal(shouldMarkPlanReady({ action: 'Reply', priority: null, status: 'Not started' }), false);
  assert.equal(shouldMarkPlanReady({ action: '', priority: null, status: 'Not started' }), false);
});

test('exported action set matches the poller pipeline definitions', () => {
  // If PIPELINES in notion-action-poll.js gains a new non-implementing action,
  // this set must be updated — the test pins today's contract.
  assert.deepEqual([...PLAN_ONLY_ACTIONS].sort(), ['Investigate', 'Plan', 'Plan+Review', 'Review']);
});
