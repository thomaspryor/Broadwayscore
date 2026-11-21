// Tests for scripts/lib/session-metrics.js's pure transcript-analysis
// functions (BRO-140 recheck of the S2 gate-fix / S1 reminder-size cards).
// Fixtures mirror the real shapes found in
// ~/.claude/projects/-Users-tompryor-Broadwayscore/*.jsonl: gate blocks are
// `type: "system", subtype: "stop_hook_summary"` entries with a
// `hookErrors[]` array, and the task-list reminder is an
// `attachment.type === "task_reminder"` entry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  countGateBlocks,
  detectGateHookCrashes,
  measureTaskReminderTokenSizes,
  averageBlocksPerSession,
} = require('../../scripts/lib/session-metrics.js');

function stopHookSummary(hookErrors) {
  return { type: 'system', subtype: 'stop_hook_summary', hookErrors };
}

test('countGateBlocks counts one hit per gate-marker hookErrors entry', () => {
  const entries = [
    stopHookSummary([
      '[bash ~/.claude/hooks/finish-line-gate.sh]: 🛑 FINISH-LINE GATE:\n\nfinish the chain',
      '[bash ~/.claude/hooks/exit-status-gate.sh]: 🛑 EXIT-STATUS GATE:\n\nadd an exit-status line',
    ]),
    { type: 'user', message: { role: 'user', content: 'unrelated' } },
  ];
  assert.equal(countGateBlocks(entries), 2);
});

test('countGateBlocks ignores non-stop_hook_summary system entries and unrelated hookErrors', () => {
  const entries = [
    stopHookSummary(['[bash ~/.claude/hooks/memory-index-cap-postcheck.sh]: MEMORY.md is OVER CAP']),
    { type: 'system', subtype: 'other', hookErrors: ['EXIT-STATUS GATE'] },
  ];
  assert.equal(countGateBlocks(entries), 0);
});

test('countGateBlocks sums across multiple turns in the same session', () => {
  const entries = [
    stopHookSummary(['[bash ~/.claude/hooks/exit-status-gate.sh]: 🛑 EXIT-STATUS GATE:\n\nfix it']),
    stopHookSummary(['[bash ~/.claude/hooks/exit-status-gate.sh]: 🛑 EXIT-STATUS GATE:\n\nstill missing']),
    stopHookSummary(['[bash ~/.claude/hooks/finish-line-gate.sh]: 🛑 FINISH-LINE GATE:\n\nrun ship-check']),
  ];
  assert.equal(countGateBlocks(entries), 3);
});

test('detectGateHookCrashes flags a gate-hook error with no known marker as a crash', () => {
  const entries = [
    stopHookSummary(['[bash ~/.claude/hooks/exit-status-gate.sh]: Traceback (most recent call last):\n  ...\nKeyError: \'foo\'']),
  ];
  const crashes = detectGateHookCrashes(entries);
  assert.equal(crashes.length, 1);
  assert.match(crashes[0], /Traceback/);
});

test('detectGateHookCrashes does not flag a normal marker-carrying block as a crash', () => {
  const entries = [
    stopHookSummary(['[bash ~/.claude/hooks/finish-line-gate.sh]: 🛑 FINISH-LINE GATE:\n\nfinish the chain']),
  ];
  assert.deepEqual(detectGateHookCrashes(entries), []);
});

test('detectGateHookCrashes ignores crashes from unrelated hooks', () => {
  const entries = [
    stopHookSummary(['[bash ~/.claude/hooks/session-stop.sh]: Traceback (most recent call last):\n  boom']),
  ];
  assert.deepEqual(detectGateHookCrashes(entries), []);
});

test('measureTaskReminderTokenSizes estimates chars/4 per task_reminder attachment', () => {
  const content = [{ id: '1', subject: 'x'.repeat(996) }]; // JSON.stringify adds wrapper chars
  const entries = [{ attachment: { type: 'task_reminder', content } }];
  const [size] = measureTaskReminderTokenSizes(entries);
  const expected = Math.ceil(JSON.stringify(content).length / 4);
  assert.equal(size, expected);
  assert.ok(size > 0);
});

test('measureTaskReminderTokenSizes ignores non-task_reminder attachments', () => {
  const entries = [{ attachment: { type: 'hook_success', content: 'noise'.repeat(1000) } }];
  assert.deepEqual(measureTaskReminderTokenSizes(entries), []);
});

test('averageBlocksPerSession matches the audit metric shape (total / session count)', () => {
  assert.equal(averageBlocksPerSession([0, 1, 2, 5]), 2);
  assert.equal(averageBlocksPerSession([]), 0);
});

test('acceptance thresholds: a fixture fleet at the S2 target (<1.0 blocks/session, 0 crashes) passes', () => {
  const sessionA = [stopHookSummary(['[bash ~/.claude/hooks/exit-status-gate.sh]: 🛑 EXIT-STATUS GATE:\n\nx'])];
  const sessionB = [stopHookSummary(['unrelated hook note'])];
  const sessionC = [];
  const perSession = [sessionA, sessionB, sessionC].map(countGateBlocks);
  assert.ok(averageBlocksPerSession(perSession) < 1.0, 'fixture fleet should be under the 1.0 target');
  const crashes = [sessionA, sessionB, sessionC].flatMap(detectGateHookCrashes);
  assert.deepEqual(crashes, []);
});

test('acceptance thresholds: a fixture reminder under 15K tokens passes, one over it fails', () => {
  const small = [{ attachment: { type: 'task_reminder', content: [{ id: '1', subject: 'short' }] } }];
  const [smallSize] = measureTaskReminderTokenSizes(small);
  assert.ok(smallSize < 15000);

  const big = [{ attachment: { type: 'task_reminder', content: [{ id: '1', subject: 'x'.repeat(70000) }] } }];
  const [bigSize] = measureTaskReminderTokenSizes(big);
  assert.ok(bigSize > 15000);
});
