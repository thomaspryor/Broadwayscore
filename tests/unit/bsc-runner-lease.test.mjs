// bsc-runner lease + dispatch-ledger job-event folding (Autopilot v5, #459).
// Real functions via require() — never copies (CLAUDE.md §15). Lease tests run
// against a temp LEASE_ROOT... the lib hardcodes the canonical root, so these
// tests exercise the PURE parts (foldJobs/openJobs/retriesInLast24h) plus
// pidLooksLikeClaude against real processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ledger = require('../../scripts/lib/dispatch-ledger.js');
const { pidLooksLikeClaude } = require('../../scripts/lib/bsc-runner.js');
const { retriesInLast24h } = require('../../scripts/bsc-reconcile.js');
const { parseEnvelope, STAGES, FORBIDDEN_MODEL_RE } = require('../../scripts/lib/claude-cli.js');

const E = ledger.JOB_EVENTS;

test('foldJobs: last event wins, non-job events ignored', () => {
  const entries = [
    { event: 'launch', taskId: 1, workspaceRef: 'workspace:9' },
    { event: E.SPAWNED, taskId: 42, jobId: 'j1', cwd: '/x', ts: 't1' },
    { event: E.DONE, taskId: 42, jobId: 'j1', sessionId: 's1', ts: 't2' },
    { event: E.SPAWNED, taskId: 43, jobId: 'j2', cwd: '/y', ts: 't3' },
  ];
  const jobs = ledger.foldJobs(entries);
  assert.equal(jobs.get('j1').event, E.DONE);
  assert.equal(jobs.get('j1').cwd, '/x', 'earlier fields survive the fold');
  assert.equal(jobs.get('j2').event, E.SPAWNED);
  assert.equal(jobs.size, 2);
});

test('openJobs: terminal states excluded, spawned/retried included', () => {
  const entries = [
    { event: E.SPAWNED, taskId: 1, jobId: 'a' },
    { event: E.FAILED, taskId: 1, jobId: 'a', stage: 'timeout' },
    { event: E.SPAWNED, taskId: 2, jobId: 'b' },
    { event: E.SPAWNED, taskId: 3, jobId: 'c' },
    { event: E.ORPHANED, taskId: 3, jobId: 'c' },
  ];
  const open = ledger.openJobs(entries);
  assert.deepEqual(open.map(j => j.jobId), ['b']);
});

test('retriesInLast24h counts only recent job-retried events', () => {
  const now = Date.now();
  const entries = [
    { event: E.RETRIED, ts: new Date(now - 1 * 3600e3).toISOString() },
    { event: E.RETRIED, ts: new Date(now - 30 * 3600e3).toISOString() },
    { event: E.DONE, ts: new Date(now - 1 * 3600e3).toISOString() },
  ];
  assert.equal(retriesInLast24h(entries), 1);
});

test('pidLooksLikeClaude: rejects dead pids and non-claude processes', () => {
  assert.equal(pidLooksLikeClaude(999999), false, 'dead pid');
  assert.equal(pidLooksLikeClaude(process.pid), false, 'this node test process is not claude');
  assert.equal(pidLooksLikeClaude(null), false);
});

test('parseEnvelope: valid envelope, garbage, and empty-result shape', () => {
  const good = parseEnvelope(JSON.stringify({ result: 'pong', session_id: 'abc', total_cost_usd: 0.01 }));
  assert.equal(good.parsed, true);
  assert.equal(good.resultText, 'pong');
  assert.equal(good.sessionId, 'abc');
  const bad = parseEnvelope('not json at all');
  assert.equal(bad.parsed, false);
  const empty = parseEnvelope(JSON.stringify({ result: '', session_id: 'x' }));
  assert.equal(empty.parsed, true);
  assert.equal(empty.resultText, '');
});

test('forbidden-model guard covers fable and mythos in any casing', () => {
  for (const m of ['fable', 'claude-fable-5', 'MYTHOS', 'claude-mythos-5']) {
    assert.ok(FORBIDDEN_MODEL_RE.test(m), m);
  }
  for (const m of ['sonnet', 'opus', 'claude-sonnet-5', 'claude-opus-5']) {
    assert.ok(!FORBIDDEN_MODEL_RE.test(m), m);
  }
  assert.ok(Object.values(STAGES).includes('timeout'));
});
