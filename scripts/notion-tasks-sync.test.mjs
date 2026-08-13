import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { MIRROR_FMT, mapStatus, mapCardToTask, isMirrorableCard, planPull, planSelfHeal, allocateFreeId, nextId, taskBelongsTo, notionMarker, writeTask, readHwm, writeHwm, acquireLock } = require('./notion-tasks-sync.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nts-')); }

test('mapStatus maps Notion → native task status', () => {
  assert.equal(mapStatus('In progress'), 'in_progress');
  assert.equal(mapStatus('Done'), 'completed');
  assert.equal(mapStatus('Not started'), 'pending');
  assert.equal(mapStatus('Paused'), 'pending');
  assert.equal(mapStatus(undefined), 'pending');
});

test('mapCardToTask embeds notion page id and traces back', () => {
  const card = { id: 'abc123', url: 'https://n/x', name: 'Fix scoring', status: 'In progress', priority: 'P0 Now', notes: 'a\n\n  b   c' };
  const t = mapCardToTask(card, 7);
  assert.equal(t.id, '7');
  assert.equal(t.subject, 'Fix scoring');
  assert.equal(t.status, 'in_progress');
  assert.match(t.description, /\[notion:abc123\]/);
  assert.match(t.description, /P0 Now/);
  assert.match(t.description, /a b c/); // whitespace collapsed
  assert.deepEqual(t.blocks, []);
  assert.deepEqual(t.blockedBy, []);
});

// The mirror's description is the ONLY text isExcludedCategory() sees, and
// enrich-card-acceptance.js appends "VERIFY: owner-judgment" to the END of a
// card's notes — so on a long card the marker fell past the 400-char cut and
// the dispatch-time exclusion silently stopped applying (task #1154).
test('#1154: owner-judgment marker survives the 400-char notes truncation', () => {
  const { isExcludedCategory } = require('./lib/autonomous-eligibility.js');
  const longNotes = `${'x'.repeat(900)}\n\nVERIFY: owner-judgment (owner must read the report)`;
  const card = { id: 'abc', url: 'https://n/x', name: 'Quarterly relationship check-in', status: 'Not started', priority: 'P1 Next', category: 'Admin', notes: longNotes };
  const t = mapCardToTask(card, 11);

  assert.ok(t.description.length < longNotes.length, 'notes should still be truncated, not inlined whole');
  assert.match(t.description, /VERIFY: owner-judgment/);
  assert.equal(isExcludedCategory(t), true, 'a long-notes owner-judgment card must not be default-pickable');
});

test('#1154: the marker line is added only when truncation actually drops it', () => {
  // Short notes: the marker is already inside the 400 chars, so no duplicate.
  const short = mapCardToTask({ id: 'a', name: 'n', notes: 'do the thing\n\nVERIFY: owner-judgment' }, 1);
  assert.equal(short.description.match(/VERIFY: owner-judgment/g).length, 1);
  // No marker at all: nothing appended, and the card stays pickable.
  const none = mapCardToTask({ id: 'b', name: 'n', category: 'Engineering', notes: 'y'.repeat(900) }, 2);
  assert.equal(/VERIFY: owner-judgment/.test(none.description), false);
});

test('planPull creates unmapped cards, updates on status change, else unchanged', () => {
  const cards = [
    { id: 'new', status: 'Not started' },
    { id: 'moved', status: 'In progress' },
    { id: 'same', status: 'In progress' },
  ];
  const map = {
    moved: { taskId: '2', syncedStatus: 'Not started', fmt: MIRROR_FMT },
    same: { taskId: '3', syncedStatus: 'In progress', fmt: MIRROR_FMT },
  };
  const plan = planPull(cards, map);
  assert.deepEqual(plan.toCreate.map(x => x.card.id), ['new']);
  assert.deepEqual(plan.toUpdate.map(x => ({ id: x.card.id, taskId: x.taskId })), [{ id: 'moved', taskId: '2' }]);
  assert.deepEqual(plan.unchanged, ['same']);
});

test('planPull is idempotent: re-running with a fully-synced map is a no-op', () => {
  const cards = [{ id: 'a', status: 'In progress' }, { id: 'b', status: 'Not started' }];
  const map = { a: { taskId: '1', syncedStatus: 'In progress', fmt: MIRROR_FMT }, b: { taskId: '2', syncedStatus: 'Not started', fmt: MIRROR_FMT } };
  const plan = planPull(cards, map);
  assert.equal(plan.toCreate.length, 0);
  assert.equal(plan.toUpdate.length, 0);
  assert.deepEqual(plan.unchanged.sort(), ['a', 'b']);
});

// Bumping MIRROR_FMT is the ONLY thing that makes a mapCardToTask change reach
// cards that are already mirrored — planPull otherwise re-maps only on a Notion
// status change, so the #1154 truncation fix would have been a no-op for every
// existing long-notes owner-judgment card (ship-check catch).
test('#1154: an old-fmt mirror is rewritten even when its status is unchanged', () => {
  assert.ok(MIRROR_FMT > 2, 'MIRROR_FMT must be bumped past 2 for the #1154 rewrite to fire');
  const cards = [{ id: 'old', status: 'In progress' }];
  const plan = planPull(cards, { old: { taskId: '5', syncedStatus: 'In progress', fmt: 2 } });
  assert.deepEqual(plan.toUpdate.map(x => x.taskId), ['5']);
  assert.equal(plan.unchanged.length, 0);
});

test('allocateFreeId skips ids a live session already occupies', () => {
  const dir = tmpDir();
  writeTask(dir, mapCardToTask({ id: 'x', name: 'a session task' }, 3));
  writeTask(dir, mapCardToTask({ id: 'y', name: 'another' }, 4));
  assert.equal(allocateFreeId(dir, 3), 5); // 3 and 4 taken → 5
  assert.equal(allocateFreeId(dir, 1), 1); // 1 free
  fs.rmSync(dir, { recursive: true, force: true });
});

// Card #1410: a freshly minted id must never land on an already-archived
// task's id — that would permanently orphan the archived record (a
// different live task now "owns" the id, and mergeWithArchive's
// live-wins-on-collision rule hides the archived content forever).
test('allocateFreeId also skips ids present in archive/', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '5.json'), JSON.stringify({ id: '5', status: 'completed' }));
  assert.equal(allocateFreeId(dir, 5), 6, 'id 5 is taken by an archived task, not just a live one');
  assert.equal(allocateFreeId(dir, 1), 1); // unaffected when free
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nextId considers archive/ maxFile too, not just the live dir', () => {
  const dir = tmpDir();
  writeTask(dir, mapCardToTask({ id: 'x', name: 'live task' }, 3));
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '20.json'), JSON.stringify({ id: '20', status: 'completed' }));
  // No .highwatermark written — nextId must fall back to the max across BOTH
  // dirs (20), not just the live dir's max (3), or it would hand out ids
  // that collide with already-archived tasks.
  assert.equal(nextId(dir), 21);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Card #1410: producers of "BSC Daily:"-titled Notion cards moved to Linear
// (BRO-286 Phase 2) — these must never re-enter the mirror, or archiving
// them just causes planSelfHeal to re-mint a fresh id on the next pull.
test('isMirrorableCard excludes "BSC Daily:"-titled cards, includes everything else', () => {
  assert.equal(isMirrorableCard({ name: 'BSC Daily: Stuck pipeline items' }), false);
  assert.equal(isMirrorableCard({ name: 'BSC Daily: 2026-08-01 digest' }), false);
  assert.equal(isMirrorableCard({ name: 'Fix scoring bug' }), true);
  assert.equal(isMirrorableCard({ name: 'Fix: BSC Daily: legacy fix-this card' }), true, 'prefix must be anchored — only a literal leading "BSC Daily:" is excluded');
  assert.equal(isMirrorableCard({ name: undefined }), true);
  assert.equal(isMirrorableCard({}), true);
});

test('taskBelongsTo proves ownership via the [notion:<pageId>] marker', () => {
  const dir = tmpDir();
  writeTask(dir, mapCardToTask({ id: 'pageA', name: 'mine' }, 7));
  assert.equal(taskBelongsTo(dir, 7, 'pageA'), true);
  assert.equal(taskBelongsTo(dir, 7, 'pageB'), false); // reused id, different card
  assert.equal(taskBelongsTo(dir, 99, 'pageA'), false); // missing file
  // a stranger's task (no marker) is never claimed
  writeTask(dir, { id: '8', subject: 's', description: 'unrelated work', status: 'completed', blocks: [], blockedBy: [] });
  assert.equal(taskBelongsTo(dir, 8, 'pageA'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeHwm never regresses below a concurrent bump', () => {
  const dir = tmpDir();
  writeHwm(dir, 10);
  assert.equal(readHwm(dir), 10);
  writeHwm(dir, 5); // stale/lower value must not win
  assert.equal(readHwm(dir), 10);
  writeHwm(dir, 12);
  assert.equal(readHwm(dir), 12);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('notionMarker format is stable', () => {
  assert.equal(notionMarker('abc-123'), '[notion:abc-123]');
});

test('mapCardToTask mirrors category as third meta segment', () => {
  const t = mapCardToTask({ id: 'x', name: 'N', status: 'Not started', priority: 'P0 Now', category: 'Marketing', notes: '' }, 1);
  assert.match(t.description.split('\n')[0], /· Marketing$/);
  const t2 = mapCardToTask({ id: 'y', name: 'N', status: 'Not started' }, 2);
  assert.match(t2.description.split('\n')[0], /· no-category$/);
});

test('planPull upgrades stale-fmt entries even when status unchanged', () => {
  const cards = [{ id: 'a', status: 'Not started', category: 'Product' }];
  const oldMap = { a: { taskId: '1', syncedStatus: 'Not started' } };                   // no fmt
  const newMap = { a: { taskId: '1', syncedStatus: 'Not started', fmt: MIRROR_FMT } };  // current
  assert.equal(planPull(cards, oldMap).toUpdate.length, 1);  // format upgrade
  assert.equal(planPull(cards, newMap).unchanged.length, 1); // idempotent after
});

// ── Autonomous-loop claim protection (Sprint-2 carry-forward #1) ────────────
// notion-tasks-sync deliberately ignores the Auto property; the executor's
// Status→"In progress" flip is the ONLY thing keeping a claimed card from
// being double-picked via the task mirror. Lock both halves of that contract.

test('executor claim: a card flipped to In progress mirrors as in_progress, never pending', () => {
  const { mergeStatus } = require('./notion-tasks-sync.js');
  // The claimed card syncs with Notion status "In progress"
  const task = mapCardToTask({ id: 'c', name: 'Claimed card', status: 'In progress', category: 'Product' }, 7);
  assert.equal(task.status, 'in_progress');
  // and a pull can never downgrade an in-progress task back to pending
  assert.equal(mergeStatus('in_progress', 'pending'), 'in_progress');
  assert.equal(mergeStatus('completed', 'pending'), 'completed');
  assert.equal(mergeStatus('completed', 'in_progress'), 'completed');
  // forward progress still flows
  assert.equal(mergeStatus('pending', 'in_progress'), 'in_progress');
  assert.equal(mergeStatus('pending', 'completed'), 'completed');
  assert.equal(mergeStatus(undefined, 'pending'), 'pending');
});

// ── #485: .sync-lock staleness must use its own acquiredAt, not fs mtime ────
// Same bug class as json-write-guard.js and #476's monitor.lock: mtime is
// trivially reset by any unrelated process touching the lock file.

test('#485: a live lock (fresh acquiredAt) is NOT stolen even if its mtime is old', () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, '.sync-lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  const old = new Date(Date.now() - 10 * 60 * 1000); // 10 min old mtime, well past the 2-min TTL
  fs.utimesSync(lockPath, old, old);
  const release = acquireLock(dir);
  assert.equal(release, null, 'a fresh acquiredAt must block acquisition regardless of stale mtime');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#485: a stale lock (old acquiredAt) is stolen even if its mtime was just touched', () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, '.sync-lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date(Date.now() - 3 * 60 * 1000).toISOString() }));
  fs.utimesSync(lockPath, new Date(), new Date()); // unrelated touch resets mtime to "now"
  const release = acquireLock(dir);
  assert.ok(typeof release === 'function', 'a stale acquiredAt must be stolen despite a fresh mtime');
  release();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#485: an old-format lock (bare PID, no acquiredAt) falls back to mtime staleness', () => {
  const dir = tmpDir();
  const lockPath = path.join(dir, '.sync-lock');
  fs.writeFileSync(lockPath, String(process.pid)); // pre-fix format
  const old = new Date(Date.now() - 3 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);
  const release = acquireLock(dir);
  assert.ok(typeof release === 'function', 'old-format lock past the mtime TTL must still be stealable');
  release();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── Card #854: readTask falls back to archive/ ──────────────────────────────
const { readTask } = require('./notion-tasks-sync.js');

test('readTask: falls back to archive/<id>.json when the live copy has been archived', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '9.json'), JSON.stringify({ id: '9', status: 'completed', description: '[notion:abc] P1 · Done · eng' }));
  const task = readTask(dir, '9');
  assert.equal(task.status, 'completed');
  assert.equal(readTask(dir, '999'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readTask: live copy wins over an archive copy with the same id', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '9.json'), JSON.stringify({ id: '9', status: 'in_progress' }));
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '9.json'), JSON.stringify({ id: '9', status: 'completed' }));
  assert.equal(readTask(dir, '9').status, 'in_progress');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ship-check adversarial finding (2026-08-02): taskBelongsTo's default
// (archive-aware) mode is correct for cmdPush/cmdStatus, but wrong for
// cmdPull — a card reopened in Notion after its mirrored task was archived
// must NOT resolve via taskBelongsTo({liveOnly:true}), or planPull's
// toUpdate branch reads the archive's stale status:'completed' and
// mergeStatus's sticky-completed rule resurrects a permanently-stuck
// live file instead of routing to doCreate (fresh task, correct status).
const { readLiveTask } = require('./notion-tasks-sync.js');

test('taskBelongsTo: liveOnly:true does not see an archive-only match (cmdPull ownership check)', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '9.json'), JSON.stringify({ id: '9', status: 'completed', description: '[notion:abc] P1 · Done · eng' }));
  assert.equal(taskBelongsTo(dir, '9', 'abc'), true, 'default (cmdPush) mode sees the archived copy');
  assert.equal(taskBelongsTo(dir, '9', 'abc', { liveOnly: true }), false, 'liveOnly mode (cmdPull) must not');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readLiveTask: never falls back to archive/ (cmdPull\'s `existing` read)', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'archive'));
  fs.writeFileSync(path.join(dir, 'archive', '9.json'), JSON.stringify({ id: '9', status: 'completed' }));
  assert.equal(readLiveTask(dir, '9'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('planPull + readLiveTask/taskBelongsTo(liveOnly): a reopened card whose mirrored task was archived is NOT resurrected as stuck-completed', () => {
  // Simulates the exact bug: card was archived (completed >48h ago), then
  // reopened in Notion (status back to "In progress"). cmdPull's toUpdate
  // path must treat this as "id no longer belongs to us" (liveOnly check
  // fails, since the file only exists in archive/) and mint a fresh task
  // via doCreate — never write a resurrected completed copy into the live dir.
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'archive'));
  const pageId = 'abc-123';
  fs.writeFileSync(path.join(dir, 'archive', '9.json'), JSON.stringify({
    id: '9', status: 'completed', description: `[notion:${pageId}] P1 Next · Done · eng`,
  }));
  const belongsLive = taskBelongsTo(dir, '9', pageId, { liveOnly: true });
  assert.equal(belongsLive, false, 'ownership check must fail for an archive-only file — this is what routes cmdPull to doCreate');
  // If this were true (the pre-fix bug), the caller would instead do:
  //   const existing = readTask(dir, '9') || {};  // status:'completed' from archive
  //   mapped.status = mergeStatus('completed', 'pending'); // -> 'completed' (sticky)
  //   writeTask(dir, {...mapped, status: 'completed'});    // resurrected, stuck forever
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#1351: planSelfHeal recreates an "unchanged" card whose live mirror was archived (pending-population gap)', () => {
  const pageId = 'p-1';
  const map = { [pageId]: { taskId: '5' } };
  const cardsById = new Map([[pageId, { id: pageId, name: 'Still-open backlog card', status: 'Not started' }]]);
  // liveOnly miss (archived away), but the non-liveOnly check confirms the
  // archived copy still belongs to this card — matches the real
  // taskBelongsTo(dir, taskId, pageId, {liveOnly}) contract.
  const ownershipCheck = (taskId, checkedPageId, liveOnly) => {
    assert.equal(taskId, '5');
    assert.equal(checkedPageId, pageId);
    return liveOnly ? false : true;
  };
  const { toRecreate, stillUnchanged } = planSelfHeal([pageId], map, cardsById, ownershipCheck);
  assert.deepEqual(stillUnchanged, []);
  assert.equal(toRecreate.length, 1);
  assert.equal(toRecreate[0].taskId, '5');
  assert.equal(toRecreate[0].hasPriorOwnership, true);
  assert.equal(toRecreate[0].card.id, pageId);
});

test('#1351: planSelfHeal leaves a genuinely unchanged card alone (live file still present)', () => {
  const pageId = 'p-2';
  const map = { [pageId]: { taskId: '6' } };
  const cardsById = new Map([[pageId, { id: pageId, name: 'Live card', status: 'Not started' }]]);
  const ownershipCheck = () => true; // liveOnly check passes — file is still live
  const { toRecreate, stillUnchanged } = planSelfHeal([pageId], map, cardsById, ownershipCheck);
  assert.deepEqual(toRecreate, []);
  assert.deepEqual(stillUnchanged, [pageId]);
});

test('#1351: planSelfHeal does not claim prior ownership when the id was reused by an unrelated task', () => {
  const pageId = 'p-3';
  const map = { [pageId]: { taskId: '7' } };
  const cardsById = new Map([[pageId, { id: pageId, name: 'Orphaned mirror entry', status: 'Not started' }]]);
  // Neither the live nor the archive copy at id 7 belongs to this page —
  // it was reused by a completely different card. Must recreate at a fresh
  // id WITHOUT claiming prior ownership (no blocks/blockedBy carry-over).
  const ownershipCheck = () => false;
  const { toRecreate, stillUnchanged } = planSelfHeal([pageId], map, cardsById, ownershipCheck);
  assert.deepEqual(stillUnchanged, []);
  assert.equal(toRecreate.length, 1);
  assert.equal(toRecreate[0].hasPriorOwnership, false);
});

test('#1351: planSelfHeal skips a page id with no map entry or no matching fetched card', () => {
  const cardsById = new Map(); // card no longer in the fetched set (e.g. archived in Notion too)
  const { toRecreate, stillUnchanged } = planSelfHeal(['ghost-page'], { 'ghost-page': { taskId: '8' } }, cardsById, () => false);
  assert.deepEqual(toRecreate, []);
  assert.deepEqual(stillUnchanged, ['ghost-page']);
});
