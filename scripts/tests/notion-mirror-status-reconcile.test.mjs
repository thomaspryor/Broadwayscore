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
 * #1778/#1790 (2026-08-18) with unit coverage in notion-tasks-sync.test.mjs
 * and scripts/lib/notion-tasks-sync-reconcile.test.mjs. This file is the
 * BRO-2215-specific acceptance regression named in the card's own acceptance
 * criteria (`node --test scripts/tests/notion-mirror-status-reconcile.test.mjs`)
 * — it requires the REAL exported functions (CLAUDE.md rule 15: never copy
 * logic into a test file) and asserts the two required directions plus the
 * sticky-completed reopen hazard as ONE composed scenario, rather than
 * scattered unit assertions.
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

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nts-reconcile-')); }

// Direction 1 (acceptance criteria bullet 2, first half): a card that is
// Done in Notion and `pending` in the mirror becomes `completed` locally.
// planStatusDrift is what reconcileStaleMirrors calls first for every
// candidate — mapStatus('Done') already beats mergeStatus's fallthrough
// from 'pending', so this is the direct fix for the measured over-report
// (the #1154/#1311/#1696 cases cited in BRO-2215's own measurement).
test('BRO-2215 direction 1: Done in Notion + pending mirror -> completed', () => {
  const task = { id: '1154', status: 'pending' };
  const card = { status: 'Done', name: 'Shipped work', notes: '' };
  assert.deepEqual(planStatusDrift(task, card), { newStatus: 'completed', cardStatus: 'Done' });
});

// Direction 1's Paused cousin (task #1778's own scope broadening): Paused
// collapses into mapStatus()'s default 'pending' bucket alongside Not
// started, so planStatusDrift alone can't see it drift — planPendingClosure
// is the narrower function that closes it.
test('BRO-2215 direction 1b: Paused in Notion + pending mirror -> completed (planPendingClosure)', () => {
  const task = { id: '1455', status: 'pending' };
  const card = { status: 'Paused', name: 'On hold', notes: '' };
  assert.deepEqual(planPendingClosure(task, card), { newStatus: 'completed', cardStatus: 'Paused' });
});

// Direction 2 (acceptance criteria bullet 2, second half): a card that is
// Not started in Notion and `completed` in the mirror returns to `pending`.
// The mirror never flips an existing completed task file's status field
// back to pending in place — mergeStatus's sticky-completed rule (next
// test) makes that structurally impossible by design, on purpose, so a
// genuinely-finished task can never be silently reopened by a stale re-read.
// Instead the archiver (archive-completed-tasks.js) moves completed tasks
// out of the live dir, and cmdPull's ownership check is what lets a
// REOPENED card come back as a fresh pending task rather than resurrecting
// the archived completed copy: taskBelongsTo({liveOnly:true}) must reject
// an archive-only match, and readLiveTask must never fall back to archive/.
test('BRO-2215 direction 2: Not started in Notion + completed mirror (archived) -> comes back as pending, not resurrected completed', () => {
  const dir = tmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'archive'));
    const pageId = 'reopened-card-abc';
    fs.writeFileSync(
      path.join(dir, 'archive', '9.json'),
      JSON.stringify({ id: '9', status: 'completed', description: `[notion:${pageId}] P1 Next · Done · eng` }),
    );
    // cmdPull's toUpdate branch keys ownership on taskBelongsTo(liveOnly:true)
    // — an archive-only match must fail this, which is what routes the
    // reopened card to doCreate (mints a fresh id, status: pending) instead
    // of reading the archived file and reapplying mergeStatus('completed',
    // 'pending') (which would stay 'completed' — see the sticky test below).
    assert.equal(
      taskBelongsTo(dir, '9', pageId, { liveOnly: true }),
      false,
      'archive-only ownership must not count as "still ours" for cmdPull',
    );
    // readLiveTask (the `existing` lookup cmdPull's toUpdate branch actually
    // reads) must likewise never fall back to archive/, or it would read the
    // stale completed snapshot and feed it into mergeStatus.
    assert.equal(readLiveTask(dir, '9'), null, 'readLiveTask must not resurrect the archived completed copy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The sticky-completed reopen hazard named explicitly in BRO-2215's
// acceptance criteria: mergeStatus must never downgrade an existing
// 'completed' status back to 'pending' just because Notion currently reads
// Not started/In progress on a stale read — reconciliation must NEVER do
// that in place. This is exactly why direction 2 above has to go through
// the archive/doCreate route instead of a same-record status flip: a
// same-record flip would be gated shut by this same rule, on purpose (a
// genuinely finished task must never be silently reopened by drift).
test('BRO-2215 sticky-completed reopen hazard: mergeStatus never downgrades completed -> pending in place', () => {
  assert.equal(mergeStatus('completed', 'pending'), 'completed');
  assert.equal(mergeStatus('completed', 'in_progress'), 'completed');
});
