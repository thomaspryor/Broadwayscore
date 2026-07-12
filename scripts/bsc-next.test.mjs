import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { actionable, pickTask, notionIdOf, buildSeed } = require('./bsc-next.js');

const TASKS = [
  { id: '1', subject: 'P0 task', status: 'in_progress', description: '[notion:aaa] x' },
  { id: '2', subject: 'P1 pending', status: 'pending', description: '[notion:bbb] y' },
  { id: '3', subject: 'done task', status: 'completed', description: 'z' },
  { id: '4', subject: 'P2 pending', status: 'pending', description: 'no marker' },
];

test('actionable = pending before in_progress, completed dropped (no priorities)', () => {
  const a = actionable(TASKS).map(t => t.id);
  assert.deepEqual(a, ['2', '4', '1']); // all rank 9 → pending(2,4) then in_progress(1); 3 dropped
});

test('actionable sorts by Notion priority first (P0 beats P1 beats unranked)', () => {
  const T = [
    { id: '1', subject: 'p1 inprog', status: 'in_progress', description: '[notion:a] P1 Next · In progress' },
    { id: '2', subject: 'unranked pending', status: 'pending', description: 'no marker' },
    { id: '3', subject: 'p0 pending', status: 'pending', description: '[notion:c] P0 Now · Not started' },
    { id: '4', subject: 'p1 pending', status: 'pending', description: '[notion:d] P1 Next · Not started' },
  ];
  // P0(3) → P1 pending(4) before P1 in_progress(1) → unranked(2)
  assert.deepEqual(actionable(T).map(t => t.id), ['3', '4', '1', '2']);
});

test('pickTask default = first actionable', () => {
  assert.equal(pickTask(TASKS, {}).id, '2');
});

test('pickTask --pick N is 1-indexed over the actionable list', () => {
  assert.equal(pickTask(TASKS, { pick: '3' }).id, '1');
  assert.equal(pickTask(TASKS, { pick: '99' }), null);
});

test('pickTask --pick with no value (true) or non-numeric defaults to top task', () => {
  assert.equal(pickTask(TASKS, { pick: true }).id, '2');   // bare --pick flag
  assert.equal(pickTask(TASKS, { pick: 'x' }).id, '2');    // garbage value
});

test('pickTask --id selects that task even if completed', () => {
  assert.equal(pickTask(TASKS, { id: '3' }).id, '3');
  assert.equal(pickTask(TASKS, { id: 'nope' }), null);
});

test('notionIdOf extracts the embedded page id, null when absent', () => {
  assert.equal(notionIdOf(TASKS[0]), 'aaa');
  assert.equal(notionIdOf(TASKS[3]), null);
});

test('buildSeed includes the task number, subject, notes, and claim instruction', () => {
  const seed = buildSeed(TASKS[1], { url: 'https://n/x', notes: 'the real problem', priority: 'P1 Next', keyFiles: 'a.ts' });
  assert.match(seed, /task #2 in_progress/);
  assert.match(seed, /CARD: P1 pending/);
  assert.match(seed, /Notion: https:\/\/n\/x/);
  assert.match(seed, /Priority: P1 Next/);
  assert.match(seed, /the real problem/);
  assert.match(seed, /ship-check/);
});

test('buildSeed falls back to task.description when no Notion card fetched', () => {
  const seed = buildSeed({ id: '9', subject: 'S', status: 'pending', description: 'fallback body' }, null);
  assert.match(seed, /fallback body/);
});
