import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ESCALATION_HOURS, RESTAMP_HOURS, decideRedEscalation, stampStartNow, escalationUpdate,
  lastEscalationCommentMs, ESCALATION_COMMENT_PREFIX,
} = require('./red-escalation.js');
const { isStartNow, startNowUnpickableReason } = require('./cloud-worker-pick.js');

const H = 3600_000;
const NOW = Date.parse('2026-11-08T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ENV = {};
const cond = (over = {}) => ({ status: 'open', incidentOpenedAt: iso(NOW - 7 * H), linearIdentifier: 'BRO-1', ...over });
const card = (over = {}) => ({
  id: 'uuid-1', identifier: 'BRO-1', title: 'test.yml red: Unit Tests', priority: 3,
  description: '## Problem\nUnit Tests red.\n\n## Acceptance criteria\n`node --test scripts/lib/x.test.mjs` passes.',
  updatedAt: iso(NOW - 10 * H), state: { id: 's-todo', name: 'Todo', type: 'unstarted' }, ...over,
});
const decide = (over = {}) => decideRedEscalation({ condition: cond(), card: card(), nowMs: NOW, env: ENV, ...over });

test('escalates a signature red past the threshold whose card is idle', () => {
  const d = decide();
  assert.equal(d.escalate, true);
  assert.equal(d.reason, 'red-too-long');
  assert.ok(Math.abs(d.ageHours - 7) < 1e-9);
});

test('ledger-side holds: kill switch, closed, young, recently escalated, no start', () => {
  assert.equal(decide({ env: { RED_ESCALATION_DISABLED: 'true' } }).reason, 'kill-switch');
  assert.equal(decide({ condition: cond({ status: 'resolved' }) }).reason, 'not-open');
  assert.equal(decide({ condition: cond({ incidentOpenedAt: iso(NOW - (ESCALATION_HOURS - 0.5) * H) }) }).reason, 'too-young');
  assert.equal(decide({ condition: cond({ escalatedAt: iso(NOW - (RESTAMP_HOURS - 1) * H) }) }).reason, 'escalated-recently');
  assert.equal(decide({ condition: cond({ escalatedAt: iso(NOW - (RESTAMP_HOURS + 1) * H) }) }).escalate, true);
  assert.equal(decide({ condition: cond({ incidentOpenedAt: undefined, firstSeen: undefined }) }).reason, 'no-incident-start');
  // firstSeen is the fallback clock.
  assert.equal(decide({ condition: cond({ incidentOpenedAt: undefined, firstSeen: iso(NOW - 8 * H) }) }).escalate, true);
});

test('card-side holds: missing, closed, owner-held, no-dispatch, being worked, awaiting owner', () => {
  assert.equal(decide({ card: null }).reason, 'no-card');
  assert.equal(decide({ card: card({ state: { type: 'completed', name: 'Done' } }) }).reason, 'card-completed');
  assert.equal(decide({ card: card({ state: { type: 'canceled', name: 'Canceled' } }) }).reason, 'card-canceled');
  assert.equal(decide({ card: card({ description: 'PARKED: owner call\nbody' }) }).reason, 'owner-held');
  assert.equal(decide({ card: card({ description: 'NO-DISPATCH: manual\nbody' }) }).reason, 'no-dispatch-marker');
  const started = { id: 's', type: 'started', name: 'In Progress' };
  assert.equal(decide({ card: card({ state: started, updatedAt: iso(NOW - 1 * H) }) }).reason, 'being-worked');
  // A started card nobody touched for 6h+ is stuck, not being worked.
  assert.equal(decide({ card: card({ state: started, updatedAt: iso(NOW - 7 * H) }) }).escalate, true);
  assert.equal(decide({ historyReason: 'awaiting-owner' }).reason, 'awaiting-owner');
  assert.equal(decide({ historyReason: 'recently-paused' }).escalate, true);
});

test('stampStartNow replaces older stamps and the cloud worker reads the new one', () => {
  const nowIso = iso(NOW - 20 * 60_000);
  const once = stampStartNow(card().description, { ageHours: 7.9, nowIso: iso(NOW - 30 * H) });
  const twice = stampStartNow(once, { ageHours: 31.2, nowIso });
  assert.equal((twice.match(/^START-NOW:/gm) || []).length, 1);
  assert.equal((twice.match(/^START-NOW-SINCE:/gm) || []).length, 1);
  assert.match(twice, /^START-NOW: main has been red on this signature for 31h/);
  assert.ok(twice.includes(`START-NOW-SINCE: ${nowIso}`));
  assert.ok(twice.endsWith(card().description));
  // A 5-day-old card carrying the fresh stamp is in the START-NOW window.
  const issue = { ...card({ description: twice, priority: 2 }), createdAt: iso(NOW - 5 * 24 * H) };
  assert.equal(isStartNow(issue, NOW), true);
});

test('escalationUpdate: priority, Backlog/Paused -> Todo, stamp only when pickable', () => {
  const nowIso = iso(NOW);
  let u = escalationUpdate({ card: card(), ageHours: 7, nowIso, todoStateId: 's-todo', pickable: true });
  assert.equal(u.input.priority, 2);
  assert.equal(u.input.stateId, undefined); // already Todo
  assert.match(u.input.description, /^START-NOW:/);
  u = escalationUpdate({ card: card({ priority: 1, state: { name: 'Paused', type: 'backlog' } }), ageHours: 7, nowIso, todoStateId: 's-todo', pickable: false });
  assert.equal(u.input.priority, undefined); // Urgent stays Urgent
  assert.equal(u.input.stateId, 's-todo');
  assert.equal(u.input.description, undefined);
  assert.deepEqual(u.changes, ['Paused -> Todo']);
  u = escalationUpdate({ card: card({ priority: 0 }), ageHours: 7, nowIso, todoStateId: null, pickable: false });
  assert.equal(u.input.priority, 2); // No priority -> High
});

test('a stamped red card whose VERIFY the cloud cannot run is reported, not stamped', () => {
  const stamped = stampStartNow('## Acceptance criteria\n`node scripts/run-unit-tests.js` passes.', { ageHours: 7, nowIso: iso(NOW) });
  const why = startNowUnpickableReason({ title: 't', description: stamped, priority: 2, mode: 'dispatch' });
  assert.equal(why && why.reason, 'verify-not-cloud-runnable');
  const ok = stampStartNow(card().description, { ageHours: 7, nowIso: iso(NOW) });
  assert.equal(startNowUnpickableReason({ title: 't', description: ok, priority: 2, mode: 'dispatch' }), null);
});

test('card-side dedupe: an escalation comment in the last RESTAMP_HOURS holds a second run whose ledger is stale', () => {
  // Two main runs on back-to-back pushes read the same ledger (no escalatedAt yet);
  // the first run's card comment is what stops the second.
  const recent = [{ body: `${ESCALATION_COMMENT_PREFIX} main has been red...`, createdAt: iso(NOW - 0.2 * H) }];
  assert.equal(decide({ comments: recent }).reason, 'escalated-recently-card');
  const old = [{ body: `${ESCALATION_COMMENT_PREFIX} main has been red...`, createdAt: iso(NOW - (RESTAMP_HOURS + 1) * H) }];
  assert.equal(decide({ comments: old }).escalate, true);
  // A person quoting the phrase mid-comment is not our marker.
  const quoted = [{ body: `see "${ESCALATION_COMMENT_PREFIX}" above`, createdAt: iso(NOW - 0.2 * H) }];
  assert.equal(decide({ comments: quoted }).escalate, true);
  assert.equal(lastEscalationCommentMs([]), null);
  assert.equal(lastEscalationCommentMs([...old, ...recent]), NOW - 0.2 * H);
});

test('review fixes: escalation comment is a machine comment; holds and lanes; stuck started card goes to Todo', () => {
  const { pausedHistorySkipReason } = require('./cloud-worker-pick.js');
  const { buildOutcomeCommentBody } = require('./linear-session-reporting.js');
  // A card paused 3 times stays paused-repeatedly after our escalation comment lands.
  const paused = (h) => ({ body: buildOutcomeCommentBody({ summary: 'Blocked on the same wall.', status: 'paused' }), createdAt: iso(NOW - h * H) });
  const ours = { body: `${ESCALATION_COMMENT_PREFIX} main has been red on this signature for 30.0h.`, createdAt: iso(NOW - 1 * H) };
  const base = [paused(80), paused(60), paused(40)];
  assert.equal(pausedHistorySkipReason(base, NOW, {}), 'paused-repeatedly');
  assert.equal(pausedHistorySkipReason([...base, ours], NOW, {}), 'paused-repeatedly', 'our comment must not read as an answer');
  // The old prefix did read as an answer (the bug this guards).
  assert.notEqual(pausedHistorySkipReason([...base, { ...ours, body: 'Escalated (BRO-7102): main red' }], NOW, {}), 'paused-repeatedly');
  // Someone-else's-call holds stop the escalation outright.
  for (const r of ['recheck-pending', 'reclaimed-to-backlog', 'backlog-unexplained', 'awaiting-owner']) {
    assert.equal(decide({ historyReason: r }).reason, r);
  }
  // A started card idle past ACTIVE_WORK_HOURS is moved back to Todo so START-NOW can be picked.
  const stuck = card({ state: { id: 's-ip', type: 'started', name: 'In Progress' }, updatedAt: iso(NOW - 8 * H) });
  const u = escalationUpdate({ card: stuck, ageHours: 9, nowIso: iso(NOW), todoStateId: 's-todo', pickable: true });
  assert.equal(u.input.stateId, 's-todo');
});

test('routeAlert rewrites keep the escalation clock while the incident is open', () => {
  const { carriedRedFirstFields } = require('./owner-alert-router.js');
  const at = iso(NOW - H);
  assert.deepEqual(carriedRedFirstFields({ status: 'open', escalatedAt: at, escalationLane: 'cloud-start-now' }), { escalatedAt: at, escalationLane: 'cloud-start-now' });
  assert.equal(carriedRedFirstFields({ status: 'resolved', escalatedAt: at }).escalatedAt, undefined);
});
