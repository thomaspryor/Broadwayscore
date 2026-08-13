// classifyTrapped contract (archiver deadlock recovery). Per CLAUDE.md §15 this
// require()s the real predicate rather than restating it, so a change to the
// production classification fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyTrapped, dispatchedTaskIds } = require('../audit-archived-in-progress.js');

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
