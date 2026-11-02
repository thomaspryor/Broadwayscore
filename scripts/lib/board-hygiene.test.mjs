import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const h = require('./board-hygiene.js');
const NOW = Date.parse('2026-11-02T12:00:00Z');
let n = 0;
const card = (o = {}) => ({ identifier: `BRO-${++n}`, title: 't', priority: 3, createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', state: { name: 'Backlog', type: 'backlog' }, comments: { nodes: [] }, description: '', ...o });

test('prose stamps: a written date wins, durations count from the last touch, a stamped card is skipped', () => {
  const a = card({ description: 'PARKED: date: promote no earlier than 2026-11-13, after one clean week', updatedAt: '2026-10-30T00:00:00Z' });
  const b = card({ description: 'PARKED: needs about a week of per-lane data to accrue', updatedAt: '2026-10-30T00:00:00Z' });
  const c = card({ description: 'PARKED: waits for 2 weeks of hit data\nRECHECK-AFTER: 2026-11-12' });
  const d = card({ description: 'PARKED: needs an API key' });
  const plan = h.planProseStamps([a, b, c, d], NOW);
  assert.deepEqual(plan.map((p) => [p.identifier, p.date]), [[a.identifier, '2026-11-13'], [b.identifier, '2026-11-06']]);
});
test('prose stamps: a date already past is pushed to tomorrow, never today', () => {
  const a = card({ description: 'PARKED: waits until 2026-10-16 for tour reviews' });
  assert.equal(h.planProseStamps([a], NOW)[0].date, '2026-11-03');
});
test('machine logs: only Backlog routine audit logs, never a do-not-close card', () => {
  const log = card({ description: 'PARKED: routine audit log' });
  const keep = card({ description: 'PARKED: routine audit log. Not work: do not close' });
  const todo = card({ description: 'PARKED: routine audit log', state: { name: 'Todo', type: 'unstarted' } });
  assert.deepEqual(h.planMachineLogs([log, keep, todo]).map((x) => x.identifier), [log.identifier]);
});
test('age sweep: dispatch, needs-VERIFY, reconfirm and skip lanes; it never closes', () => {
  const dispatch = card({ priority: 2, description: 'VERIFY: node --test x.test.mjs' });
  const needs = card({ priority: 4, description: 'old defect, no verify' });
  const reconfirm = card({ priority: 3, description: 'PARKED: waiting for upstream fix' });
  const fresh = card({ createdAt: '2026-10-25T00:00:00Z', priority: 4 });
  const queued = card({ priority: 4, state: { name: 'Todo', type: 'unstarted' }, description: 'VERIFY: node --test y.test.mjs' });
  const started = card({ priority: 4, state: { name: 'In Progress', type: 'started' } });
  const tracker = card({ priority: 4, description: 'tracker card, not a task' });
  const stamped = card({ priority: 4, description: 'RECHECK-AFTER: 2026-12-01' });
  const done = card({ priority: 3, description: 'PARKED: x', comments: { nodes: [{ body: 'AGE-SWEEP-RECONFIRMED: 2026-10-20\nstill parked', createdAt: '2026-10-20T00:00:00Z' }] } });
  const r = h.planAgeSweep([dispatch, needs, reconfirm, fresh, queued, started, tracker, stamped, done], NOW);
  assert.deepEqual(r.dispatch.map((x) => x.identifier), [dispatch.identifier]);
  assert.deepEqual(r.needsVerify.map((x) => x.identifier), [needs.identifier]);
  assert.deepEqual(r.reconfirm.map((x) => x.identifier), [reconfirm.identifier]);
  assert.deepEqual(r.skipped.map((x) => x.identifier).sort(), [queued.identifier, started.identifier, tracker.identifier, stamped.identifier, done.identifier].sort());
  assert.equal(r.close, undefined);
});
test('age sweep: a reconfirm older than 30 days brings the card back', () => {
  const c = card({ priority: 3, description: 'PARKED: x', comments: { nodes: [{ body: 'AGE-SWEEP-RECONFIRMED: 2026-09-20', createdAt: '2026-09-20T00:00:00Z' }] } });
  assert.equal(h.planAgeSweep([c], NOW).reconfirm.length, 1);
});
