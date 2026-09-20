/**
 * linear-dead-completion-source.test.mjs — BRO-3431.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const src = require('./linear-dead-completion-source.js');

test('findLinearDeadLaunchCandidates: a dead linear: launch with no terminal event is a candidate', () => {
  const entries = [
    { event: 'launch', taskId: 'linear:BRO-100', ts: '2026-09-01T00:00:00.000Z', workspaceRef: 'workspace:1' },
    { event: 'dead', taskId: 'linear:BRO-100', ts: '2026-09-01T00:05:00.000Z', workspaceRef: 'workspace:1', deathKind: 'infra' },
  ];
  const out = src.findLinearDeadLaunchCandidates(entries);
  assert.equal(out.length, 1);
  assert.equal(out[0].identifier, 'BRO-100');
  assert.equal(out[0].taskId, 'linear:BRO-100');
});

test('findLinearDeadLaunchCandidates: a Notion (numeric) taskId is never mistaken for a Linear one', () => {
  const entries = [
    { event: 'launch', taskId: '853', ts: '2026-09-01T00:00:00.000Z', workspaceRef: 'workspace:1' },
    { event: 'dead', taskId: '853', ts: '2026-09-01T00:05:00.000Z', workspaceRef: 'workspace:1', deathKind: 'infra' },
  ];
  assert.deepEqual(src.findLinearDeadLaunchCandidates(entries), []);
});

test('findLinearDeadLaunchCandidates: a job-done after the launch is not a candidate', () => {
  const entries = [
    { event: 'launch', taskId: 'linear:BRO-200', ts: '2026-09-01T00:00:00.000Z', workspaceRef: 'workspace:1' },
    { event: 'job-done', taskId: 'linear:BRO-200', ts: '2026-09-01T00:10:00.000Z', workspaceRef: 'workspace:1' },
  ];
  assert.deepEqual(src.findLinearDeadLaunchCandidates(entries), []);
});

test('findLinearDeadLaunchCandidates: empty/malformed input never throws', () => {
  assert.deepEqual(src.findLinearDeadLaunchCandidates([]), []);
  assert.deepEqual(src.findLinearDeadLaunchCandidates(null), []);
  assert.deepEqual(src.findLinearDeadLaunchCandidates([null, {}, { taskId: 'linear:' }]), []);
});

test('shouldReopenLinearIssue: only a completed-type state reopens', () => {
  assert.equal(src.shouldReopenLinearIssue({ state: { type: 'completed' } }), true);
  assert.equal(src.shouldReopenLinearIssue({ state: { type: 'started' } }), false);
  assert.equal(src.shouldReopenLinearIssue(null), false);
});
