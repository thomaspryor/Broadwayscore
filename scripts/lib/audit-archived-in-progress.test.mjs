// classifyTrapped contract (archiver deadlock recovery). Per CLAUDE.md §15 this
// require()s the real predicate rather than restating it, so a change to the
// production classification fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyTrapped, dispatchedTaskIds, applyDecision, writeVerified, readLiveTasks, DEFAULT_FIX_LIMIT, MAX_UNCONFIRMED_FIX_LIMIT } = require('../audit-archived-in-progress.js');

const NOW = Date.UTC(2026, 7, 13, 2, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

test('classifyTrapped: only in_progress archived tasks count as trapped', () => {
  const { trapped } = classifyTrapped([
    { id: '1', status: 'in_progress', subject: 'a', mtimeMs: NOW - 3 * DAY },
    { id: '2', status: 'completed', subject: 'b', mtimeMs: NOW - 3 * DAY },
    { id: '3', status: 'pending', subject: 'c', mtimeMs: NOW - 3 * DAY },
  ], new Set(), NOW);
  assert.deepEqual(trapped.map((t) => t.id), ['1']);
});

test('classifyTrapped: splits on whether the task ever reached the dispatch ledger', () => {
  const tasks = [
    { id: '10', status: 'in_progress', subject: 'never ran', mtimeMs: NOW - 2 * DAY },
    { id: '11', status: 'in_progress', subject: 'did run', mtimeMs: NOW - 2 * DAY },
  ];
  const { neverStarted, startedAndLost } = classifyTrapped(tasks, new Set(['11']), NOW);
  assert.deepEqual(neverStarted.map((t) => t.id), ['10']);
  assert.deepEqual(startedAndLost.map((t) => t.id), ['11'],
    'a task with ledger rows may have real commits on a job branch — it must not be lumped in with never-started');
});

test('classifyTrapped: ledger ids are compared as strings, not by identity', () => {
  // dispatch-ledger.jsonl carries taskId as a string ("1355"); the task store's
  // own id can arrive as a number. A === comparison across those types would
  // silently classify every started task as never-started.
  const { startedAndLost } = classifyTrapped(
    [{ id: 1355, status: 'in_progress', subject: 'numeric id', mtimeMs: NOW - DAY }],
    new Set(['1355']), NOW);
  assert.deepEqual(startedAndLost.map((t) => t.id), ['1355']);
});

test('classifyTrapped: sorts oldest first and reports age in whole days', () => {
  const { trapped } = classifyTrapped([
    { id: '1', status: 'in_progress', subject: 'newer', mtimeMs: NOW - 2 * DAY },
    { id: '2', status: 'in_progress', subject: 'older', mtimeMs: NOW - 9 * DAY },
  ], new Set(), NOW);
  assert.deepEqual(trapped.map((t) => t.id), ['2', '1']);
  assert.equal(trapped[0].ageDays, 9);
  assert.equal(trapped[1].ageDays, 2);
});

test('classifyTrapped: survives missing mtime and missing subject without throwing', () => {
  const { trapped } = classifyTrapped([
    { id: '1', status: 'in_progress' },
  ], new Set(), NOW);
  assert.equal(trapped[0].ageDays, null);
  assert.equal(trapped[0].subject, '(no subject)');
});

test('classifyTrapped: null/garbage input is empty, never a crash', () => {
  assert.deepEqual(classifyTrapped(null, new Set(), NOW).trapped, []);
  assert.deepEqual(classifyTrapped([null, undefined], new Set(), NOW).trapped, []);
});

test('dispatchedTaskIds: returns null (not an empty Set) when the ledger is unreadable', () => {
  // The ledger is gitignored, so it is ABSENT in every git worktree. Returning
  // an empty Set there made this audit report "86 never started, 0 started" —
  // a confidently wrong answer; the real split is 59/27. Absent input must be
  // distinguishable from "the answer is zero" so main() can refuse.
  assert.equal(dispatchedTaskIds('/nonexistent/repo/root/for/this/test'), null);
});

test('dispatchedTaskIds: a real ledger yields a non-empty Set of string ids', () => {
  // Guards the other direction: a null-vs-Set mixup that always refused would
  // be just as broken as one that always answered zero.
  const ids = dispatchedTaskIds(path.join(import.meta.dirname, '..', '..'));
  if (ids === null) return; // running in a worktree — the refusal path is covered above
  assert.ok(ids instanceof Set);
  assert.ok(ids.size > 0, 'a present ledger must produce at least one launched id');
  for (const id of ids) { assert.equal(typeof id, 'string'); break; }
});

const EXEC_NOW = Date.parse('2026-08-14T12:00:00.000Z');

// Real directories, real writes — applyDecision is the half that actually
// mutates the task store, and it had zero coverage (ship-check). The first
// live --fix run crashed on a missing export precisely because only the
// pure classifier was exercised.
function scratch(archived) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-exec-'));
  const archiveDir = path.join(dir, 'archive');
  fs.mkdirSync(archiveDir);
  if (archived) fs.writeFileSync(path.join(archiveDir, `${archived.id}.json`), JSON.stringify(archived, null, 2));
  return { dir, archiveDir, live: (id) => path.join(dir, `${id}.json`), arch: (id) => path.join(archiveDir, `${id}.json`) };
}
const execTrapped = (id) => ({ id: String(id), status: 'in_progress', owner: 'someone', subject: `Trapped #${id}`, description: `[notion:aaaa${id}aaa-1111-2222-3333-444444444444] P1 Next · In progress · Product` });
const ctx = (s, over = {}) => ({ liveDir: s.dir, archiveDir: s.archiveDir, now: EXEC_NOW, correctCardFn: () => true, ...over });

test('reclaim writes the live copy and removes the archive copy', () => {
  const s = scratch(execTrapped(9));
  const r = applyDecision({ id: '9', action: 'reclaim', reason: 'x', cardStatus: 'In progress' }, ctx(s));
  assert.equal(r.done, true);
  const live = JSON.parse(fs.readFileSync(s.live(9), 'utf8'));
  assert.equal(live.status, 'pending');
  assert.equal(live.owner, null);
  assert.ok(live.reclaimedFromArchiveAt);
  assert.equal(fs.existsSync(s.arch(9)), false, 'archive copy must be gone or the next run sees a self-twin');
});

test('reclaim refuses to clobber an existing live file under the same id', () => {
  const s = scratch(execTrapped(9));
  fs.writeFileSync(s.live(9), JSON.stringify({ id: '9', status: 'pending', subject: 'someone else' }));
  const r = applyDecision({ id: '9', action: 'reclaim', reason: 'x' }, ctx(s));
  assert.equal(r.done, false);
  assert.match(r.why, /refusing to clobber/);
  assert.equal(fs.existsSync(s.arch(9)), true, 'archive copy must survive a refused reclaim');
});

test('park-outcome writes a COMPLETED archive record, never pending', () => {
  const s = scratch(execTrapped(9));
  const r = applyDecision({ id: '9', action: 'park-outcome', reason: 'card already records a completed Outcome', cardStatus: 'In progress' }, ctx(s));
  assert.equal(r.done, true);
  const arch = JSON.parse(fs.readFileSync(s.arch(9), 'utf8'));
  assert.equal(arch.status, 'completed', 'a pending archive record arms p01Queue and zombie-tab-sweep');
  assert.equal(fs.existsSync(s.live(9)), false, 'a park must not return the task to the live pool');
});

test('park-outcome writes the Notion card only when it still reads In progress', () => {
  const calls = [];
  const s1 = scratch(execTrapped(9));
  applyDecision({ id: '9', action: 'park-outcome', reason: 'r', cardStatus: 'In progress', notionId: 'nid-1' }, ctx(s1, { correctCardFn: (...a) => { calls.push(a); return true; } }));
  assert.equal(calls.length, 1);

  const s2 = scratch(execTrapped(9));
  applyDecision({ id: '9', action: 'park-outcome', reason: 'r', cardStatus: 'Done', notionId: 'nid-1' }, ctx(s2, { correctCardFn: (...a) => { calls.push(a); return true; } }));
  assert.equal(calls.length, 1, 'an already-Done card must never be downgraded to Paused');
});

// ── ship-check B1: the interrupted-reclaim resume ──────────────────────────
test('B1: resume finishes an interrupted reclaim by dropping the stale archive copy', () => {
  const s = scratch(execTrapped(9));
  fs.writeFileSync(s.live(9), JSON.stringify({ ...execTrapped(9), status: 'pending', owner: null, reclaimedFromArchiveAt: '2026-08-14T00:00:00.000Z' }));
  const r = applyDecision({ id: '9', action: 'resume-interrupted-reclaim', reason: 'x' }, ctx(s));
  assert.equal(r.done, true);
  assert.equal(fs.existsSync(s.arch(9)), false);
  assert.equal(JSON.parse(fs.readFileSync(s.live(9), 'utf8')).status, 'pending', 'the live copy is left exactly as the reclaim wrote it');
});

test('B1: resume refuses when the live copy is NOT a reclaimed record (id reused)', () => {
  const s = scratch(execTrapped(9));
  fs.writeFileSync(s.live(9), JSON.stringify({ id: '9', status: 'pending', subject: 'unrelated task that reused this id' }));
  const r = applyDecision({ id: '9', action: 'resume-interrupted-reclaim', reason: 'x' }, ctx(s));
  assert.equal(r.done, false);
  assert.equal(fs.existsSync(s.arch(9)), true, 'dropping the archive copy here would lose an unrelated task history');
});

// ── check-then-act ─────────────────────────────────────────────────────────
test('a task that stopped being in_progress between scan and write is skipped', () => {
  const s = scratch({ ...execTrapped(9), status: 'completed' });
  const r = applyDecision({ id: '9', action: 'reclaim', reason: 'x' }, ctx(s));
  assert.equal(r.done, false);
  assert.match(r.why, /no longer trapped/);
});

test('a vanished archive copy is reported, not thrown', () => {
  const s = scratch(null);
  const r = applyDecision({ id: '9', action: 'reclaim', reason: 'x' }, ctx(s));
  assert.equal(r.done, false);
  assert.match(r.why, /vanished/);
});

// ── helpers ────────────────────────────────────────────────────────────────
test('writeVerified confirms content by read-back', () => {
  const s = scratch(null);
  const p = path.join(s.dir, 'x.json');
  assert.equal(writeVerified(p, '{"a":1}\n'), true);
  assert.equal(fs.readFileSync(p, 'utf8'), '{"a":1}\n');
});

test('readLiveTasks ignores archive/ and non-task files', () => {
  const s = scratch(execTrapped(9));
  fs.writeFileSync(s.live(5), JSON.stringify({ id: '5', status: 'pending' }));
  fs.writeFileSync(path.join(s.dir, '.notion-map.json'), '{}');
  const ids = readLiveTasks(s.dir).map((t) => String(t.id)).sort();
  assert.deepEqual(ids, ['5']);
});

test('the batch caps are the documented values', () => {
  assert.equal(DEFAULT_FIX_LIMIT, 10);
  assert.equal(MAX_UNCONFIRMED_FIX_LIMIT, 25);
});
