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

// BRO-4075: the exact BRO-4065 live-incident shape — a job classified
// job-stopped-short, then a separate session re-verifies the commits landed
// and writes landed-acked. Before the isAttemptEvent fix, this task still
// showed up as a dead-launch candidate (latestAttemptForTask skipped past the
// landed-acked row), and reconcile-dead-completions.js reopened the
// already-Done Linear issue off the back of it.
test('findLinearDeadLaunchCandidates: a stopped-short job followed by a landed-acked row is NOT a candidate', () => {
  const entries = [
    { event: 'launch', taskId: 'linear:BRO-4065', ts: '2026-09-23T06:00:00.000Z', workspaceRef: 'headless:linear:BRO-4065' },
    { event: 'job-spawned', taskId: 'linear:BRO-4065', jobId: 'j4065', ts: '2026-09-23T06:01:00.000Z' },
    { event: 'job-stopped-short', taskId: 'linear:BRO-4065', jobId: 'j4065', ts: '2026-09-23T06:11:07.000Z' },
    { event: 'landed-acked', taskId: 'linear:BRO-4065', jobId: 'j4065', sha: 'ff10e4de1a6', ts: '2026-09-23T06:15:41.000Z' },
  ];
  assert.deepEqual(src.findLinearDeadLaunchCandidates(entries), []);
});

test('findLinearDeadLaunchCandidates: a stopped-short job with NO ack row is still a candidate (regression guard for the fix above)', () => {
  const entries = [
    { event: 'launch', taskId: 'linear:BRO-4066', ts: '2026-09-23T06:00:00.000Z', workspaceRef: 'headless:linear:BRO-4066' },
    { event: 'job-spawned', taskId: 'linear:BRO-4066', jobId: 'j4066', ts: '2026-09-23T06:01:00.000Z' },
    { event: 'job-stopped-short', taskId: 'linear:BRO-4066', jobId: 'j4066', ts: '2026-09-23T06:11:07.000Z' },
  ];
  const out = src.findLinearDeadLaunchCandidates(entries);
  assert.equal(out.length, 1);
  assert.equal(out[0].taskId, 'linear:BRO-4066');
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
