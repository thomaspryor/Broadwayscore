import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyHeadlessResult, lastContentLine } = require('../../scripts/lib/headless-result-classifier.js');
const { JOB_EVENTS, TERMINAL_JOB_EVENTS, foldJobs } = require('../../scripts/lib/dispatch-ledger.js');

test('classifyHeadlessResult: clean CLOSE ME with no BLOCKED reason', () => {
  const text = [
    'Some narration about work done.',
    '  ──────────────────────────────────────────',
    '  DONE          shipped the thing',
    '  CONTINUING    none',
    '  NEEDS YOU     nothing',
    '  THIS SESSION: CLOSE ME — nothing outstanding',
    '  ──────────────────────────────────────────',
  ].join('\n');
  assert.deepEqual(classifyHeadlessResult(text), { outcome: 'clean' });
});

test('classifyHeadlessResult: clean IDLE also counts as clean', () => {
  const text = 'THIS SESSION: IDLE — nothing running, keep only if continuing here';
  assert.deepEqual(classifyHeadlessResult(text), { outcome: 'clean' });
});

test('classifyHeadlessResult: BLOCKED extracts the reason', () => {
  const text = [
    'DECISION NEEDED: needs an owner call.',
    'THIS SESSION: CLOSE ME — BLOCKED: needs owner decision: rotate the expired API key',
  ].join('\n');
  assert.deepEqual(classifyHeadlessResult(text), {
    outcome: 'blocked',
    reason: 'needs owner decision: rotate the expired API key',
  });
});

test('classifyHeadlessResult: BLOCKED works with IDLE too, and an em dash', () => {
  const text = 'THIS SESSION: IDLE — BLOCKED: already merged via PR #42';
  assert.deepEqual(classifyHeadlessResult(text), { outcome: 'blocked', reason: 'already merged via PR #42' });
});

test('classifyHeadlessResult: BLOCKED with no reason text still classifies as blocked', () => {
  const text = 'THIS SESSION: CLOSE ME — BLOCKED:';
  assert.deepEqual(classifyHeadlessResult(text), { outcome: 'blocked', reason: 'no reason given' });
});

test('classifyHeadlessResult: KEEP OPEN is stopped-short (BRO-3388 shape)', () => {
  const text = 'THIS SESSION: KEEP OPEN — waiting on CI, will merge once green';
  const result = classifyHeadlessResult(text);
  assert.equal(result.outcome, 'stopped-short');
  assert.match(result.reason, /KEEP OPEN/);
});

test('classifyHeadlessResult: legacy NOT SAFE TO EXIT is also stopped-short', () => {
  const text = 'NOT SAFE TO EXIT — still waiting on the deploy';
  assert.equal(classifyHeadlessResult(text).outcome, 'stopped-short');
});

test('classifyHeadlessResult: no THIS SESSION line at all is stopped-short', () => {
  const text = 'Branch pushed; CI run dispatched.';
  assert.deepEqual(classifyHeadlessResult(text), {
    outcome: 'stopped-short',
    reason: 'no THIS SESSION: status line in final result',
  });
});

test('classifyHeadlessResult: empty/missing result text is stopped-short', () => {
  assert.equal(classifyHeadlessResult('').outcome, 'stopped-short');
  assert.equal(classifyHeadlessResult(undefined).outcome, 'stopped-short');
  assert.equal(classifyHeadlessResult(null).outcome, 'stopped-short');
});

test('classifyHeadlessResult: trailing decoration-only lines are skipped to find the real status line', () => {
  const text = [
    'THIS SESSION: CLOSE ME — BLOCKED: missing credential',
    '  ──────────────────────────────────────────',
    '',
  ].join('\n');
  assert.deepEqual(classifyHeadlessResult(text), { outcome: 'blocked', reason: 'missing credential' });
});

test('lastContentLine: skips blank and decoration-only trailing lines', () => {
  assert.equal(lastContentLine('a\nb\n───\n\n'), 'b');
  assert.equal(lastContentLine(''), '');
});

// Ledger-fold requirement (BRO-3442 acceptance criteria): a job whose LATEST
// event is one of the three new outcomes must be treated as terminal, same
// as job-done/job-failed/job-orphaned — never left reading as still open.
test('dispatch-ledger: job-blocked/job-stopped-short/job-stranded fold as terminal', () => {
  const base = { taskId: 'linear:BRO-3442', jobId: 'job-1', event: 'job-spawned', ts: '2026-09-15T10:00:00.000Z' };
  for (const event of [JOB_EVENTS.BLOCKED, JOB_EVENTS.STOPPED_SHORT, JOB_EVENTS.STRANDED]) {
    const entries = [base, { ...base, event, ts: '2026-09-15T10:05:00.000Z' }];
    const folded = foldJobs(entries).get('job-1');
    assert.equal(folded.event, event);
    assert.ok(TERMINAL_JOB_EVENTS.has(folded.event), `${event} must be in TERMINAL_JOB_EVENTS`);
  }
});
