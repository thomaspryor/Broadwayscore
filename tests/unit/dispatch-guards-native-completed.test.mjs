/**
 * Task #1355: staleOutcomeGuard was blind to native tasks — a task created
 * via TaskCreate has no Notion card, so `card` is null and the guard's
 * outcome-text check was a permanent no-op, even for a task whose own
 * status is already 'completed'. Requires the real predicate/guard from
 * scripts/lib/dispatch-guards.js (CLAUDE.md rule 15) rather than
 * re-deriving the decision here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { staleOutcomeGuard, isNativeTaskDoneWithoutCard } = require('../../scripts/lib/dispatch-guards.js');

const COMPLETED = { id: '1342', subject: 'Death Note-class recovery sweep', status: 'completed', description: 'no notion tag here' };
const PENDING = { id: '1343', subject: 'Some other task', status: 'pending', description: '' };
const IN_PROGRESS = { id: '1344', subject: 'Yet another task', status: 'in_progress', description: '' };

test('isNativeTaskDoneWithoutCard: true only for a completed task with no card', () => {
  assert.equal(isNativeTaskDoneWithoutCard(COMPLETED, null), true);
  assert.equal(isNativeTaskDoneWithoutCard(PENDING, null), false);
  assert.equal(isNativeTaskDoneWithoutCard(IN_PROGRESS, null), false);
  assert.equal(isNativeTaskDoneWithoutCard(COMPLETED, { outcome: '' }), false, 'a real (even outcome-less) card is not the native path');
  assert.equal(isNativeTaskDoneWithoutCard(null, null), false);
});

test('staleOutcomeGuard: refuses a completed native task (no card, no --force)', () => {
  const refusal = staleOutcomeGuard(COMPLETED, null, {});
  assert.match(refusal, /#1342/);
  assert.match(refusal, /#383 class/);
  assert.match(refusal, /already marked completed/);
});

test('staleOutcomeGuard: a pending or in_progress native task still dispatches normally (no regression)', () => {
  assert.equal(staleOutcomeGuard(PENDING, null, {}), null);
  assert.equal(staleOutcomeGuard(IN_PROGRESS, null, {}), null);
});

test('staleOutcomeGuard: a completed native task carrying a RECHECK-AFTER stamp still dispatches', () => {
  const recheckTask = { ...COMPLETED, description: 'Verifying the fix held.\nRECHECK-AFTER: 2026-08-20' };
  assert.equal(staleOutcomeGuard(recheckTask, null, {}), null);
});

test('staleOutcomeGuard: a card with a genuinely blank Outcome is NOT treated as native-completed, even if task.status is stale/racy "completed"', () => {
  // card !== null here — this must go through the existing Notion-outcome
  // branch (silent on empty outcome), not the native branch, however
  // task.status happens to read.
  assert.equal(staleOutcomeGuard(COMPLETED, { outcome: '', notes: '' }, {}), null);
});

test('staleOutcomeGuard: --force / --allow-unverifiable / --dry-run / --print-prompt all bypass the native-completed refusal', () => {
  for (const flag of ['force', 'allow-unverifiable', 'dry-run', 'print-prompt']) {
    assert.equal(staleOutcomeGuard(COMPLETED, null, { [flag]: true }), null, `${flag} must bypass`);
  }
});
