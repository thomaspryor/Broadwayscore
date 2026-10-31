/**
 * notion-mirror-status-reconcile.test.mjs — BRO-2215 acceptance.
 *
 * BRO-2215: the task mirror over-reported open P1 backlog by ~42% because
 * `notion-tasks-sync.js pull` created/updated cards it already knew about
 * but never refreshed the STATUS of a mirror entry once written — a card
 * completed in Notion stayed `pending`/`in_progress` locally forever.
 *
 * The reconciliation mechanism itself (reconcileStaleMirrors,
 * selectLeastRecentlyReconciled, planStatusDrift, planPendingClosure,
 * planLivenessDowngrade) already landed under tasks #1691/#1697/#1701/
 * #1778/#1790 (2026-08-18) with unit coverage of each individual function
 * in notion-tasks-sync.test.mjs and scripts/lib/notion-tasks-sync-reconcile
 * .test.mjs. Ship-check adversarial review of THIS file's first draft (two
 * independent reviewers, one Claude one Codex) found it was re-asserting
 * those same individual-function contracts under new names — no new
 * coverage. This version instead composes the real exported functions the
 * SAME way reconcileStaleMirrors's own loop does (planStatusDrift first,
 * planPendingClosure as the fallback), over a small backlog that models
 * BRO-2215's own measured shape, and asserts the AGGREGATE backlog-count
 * effect — the thing no single existing per-function test checks.
 *
 * The card's other acceptance bullet ("a fresh evenly-spaced sample of
 * >=25 mirror-pending P1s shows <=1 already-Done") is a live-Notion
 * measurement, not something a synthetic unit test can assert — it's made
 * repeatable via scripts/audit-mirror-status-drift.js instead (see that
 * script's own module docstring), with its pure sampling/filtering logic
 * unit-tested in scripts/lib/mirror-status-drift-sample.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  mergeStatus,
  planStatusDrift,
  planPendingClosure,
  taskBelongsTo,
  readLiveTask,
} = require('../notion-tasks-sync.js');
const { readAllTaskEntries } = require('../audit-mirror-status-drift.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nts-reconcile-')); }

// Same composition reconcileStaleMirrors's own per-candidate loop uses
// (notion-tasks-sync.js:1010-1042): planStatusDrift first (catches Done),
// planPendingClosure as the pending-only fallback (catches Paused, which
// collapses into mapStatus()'s default 'pending' bucket alongside Not
// started and so never registers as drift to planStatusDrift alone).
function resolveDrift(task, card) {
  return planStatusDrift(task, card) || (task.status === 'pending' ? planPendingClosure(task, card) : null);
}

test('BRO-2215: reconciling a mixed backlog closes every Done/Paused card and leaves genuinely-open ones alone — the aggregate over-report fix, not just individual function outputs', () => {
  // Models BRO-2215's own measured shape (11/26 sampled were already-Done)
  // at a scale a unit test can assert on precisely: 6 pending mirror
  // entries, Notion says 2 Done, 1 Paused, 3 still open.
  const backlog = [
    { task: { id: '1', status: 'pending' }, card: { status: 'Done', name: 'a' } },
    { task: { id: '2', status: 'pending' }, card: { status: 'Done', name: 'b' } },
    { task: { id: '3', status: 'pending' }, card: { status: 'Paused', name: 'c' } },
    { task: { id: '4', status: 'pending' }, card: { status: 'Not started', name: 'd' } },
    { task: { id: '5', status: 'pending' }, card: { status: 'In progress', name: 'e' } },
    { task: { id: '6', status: 'pending' }, card: { status: 'Not started', name: 'f' } },
  ];
  const reconciled = backlog.map(({ task, card }) => resolveDrift(task, card)?.newStatus || task.status);
  const stillOpen = reconciled.filter((s) => s !== 'completed').length;
  const closed = reconciled.filter((s) => s === 'completed').length;

  // Before this composition existed (planStatusDrift/planPendingClosure
  // never called), all 6 would read 'pending' forever — a 100% over-report
  // on this backlog, same class as BRO-2215's measured 42%.
  assert.equal(closed, 3, 'both Done cards and the Paused card must close');
  assert.equal(stillOpen, 3, 'Not started/In progress cards must stay open, not get swept up into completed');
  // Card 5 (Notion: "In progress") legitimately promotes pending -> in_progress
  // (mergeStatus's own pending->in_progress rule, notion-tasks-sync.js:153) —
  // a real status change, but neither an over-report fix nor a false close.
  assert.deepEqual(reconciled, ['completed', 'completed', 'completed', 'pending', 'in_progress', 'pending']);
});

// The sticky-completed reopen hazard named explicitly in BRO-2215's
// acceptance criteria: mergeStatus must never downgrade an existing
// 'completed' status back to 'pending' just because Notion currently reads
// Not started/In progress on a stale read.
test('BRO-2215 sticky-completed reopen hazard: mergeStatus never downgrades completed -> pending in place', () => {
  assert.equal(mergeStatus('completed', 'pending'), 'completed');
  assert.equal(mergeStatus('completed', 'in_progress'), 'completed');
});

// Direct consequence of the sticky rule above: a card reopened in Notion
// after its mirrored task was archived as completed must come back as a
// FRESH pending task (via cmdPull's doCreate branch), never a resurrected
// completed one — taskBelongsTo({liveOnly:true}) and readLiveTask are the
// two checks that route it there instead of reapplying mergeStatus in place
// (which the test above shows would stay stuck at 'completed').
test('BRO-2215: a card reopened after archival is not resurrected as stuck-completed', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'archive'));
    const pageId = 'reopened-card-abc';
    fs.writeFileSync(
      path.join(dir, 'archive', '9.json'),
      JSON.stringify({ id: '9', status: 'completed', description: `[notion:${pageId}] P1 Next · Done · eng` }),
    );
    assert.equal(taskBelongsTo(dir, '9', pageId, { liveOnly: true }), false);
    assert.equal(readLiveTask(dir, '9'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAllTaskEntries: reads every N.json in the mirror dir, skips corrupt/non-matching files without throwing', () => {
  const dir = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ id: '1', status: 'pending' }));
    fs.writeFileSync(path.join(dir, '2.json'), '{not valid json');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
    fs.mkdirSync(path.join(dir, 'archive'));
    fs.writeFileSync(path.join(dir, 'archive', '3.json'), JSON.stringify({ id: '3', status: 'completed' }));
    const entries = readAllTaskEntries(dir);
    assert.deepEqual(entries, [{ id: '1', status: 'pending' }], 'must not read archive/ or non-.json files, and must skip corrupt JSON silently');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAllTaskEntries: missing directory returns empty, never throws', () => {
  assert.deepEqual(readAllTaskEntries(path.join(os.tmpdir(), 'nts-reconcile-does-not-exist')), []);
});
