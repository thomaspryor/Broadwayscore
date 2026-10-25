import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { releaseStaleTaskClaim } = require('./autonomous-run.js');

// releaseStaleTaskClaim reads/writes the REAL shared-task-list location
// (~/.claude/tasks/<CLAUDE_CODE_TASK_LIST_ID>/ — see its header comment), so
// these tests point CLAUDE_CODE_TASK_LIST_ID at a disposable list under that
// same root rather than mocking fs, then clean up after themselves.
function mkTaskList() {
  const listId = `__release_claim_test_${process.pid}_${Math.floor(Math.random() * 1e6)}__`;
  const dir = path.join(os.homedir(), '.claude', 'tasks', listId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const prevListId = process.env.CLAUDE_CODE_TASK_LIST_ID;
  process.env.CLAUDE_CODE_TASK_LIST_ID = listId;
  return {
    dir,
    writeMap: map => fs.writeFileSync(path.join(dir, '.notion-map.json'), JSON.stringify(map)),
    writeTask: (id, task) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(task)),
    readTask: id => JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')),
    cleanup: () => { fs.rmSync(dir, { recursive: true, force: true }); process.env.CLAUDE_CODE_TASK_LIST_ID = prevListId; },
  };
}

test('releaseStaleTaskClaim: in_progress task mapped + marker present → released to pending', () => {
  const t = mkTaskList();
  try {
    t.writeMap({ 'card-abc': { taskId: '99' } });
    t.writeTask('99', { id: '99', status: 'in_progress', description: '[notion:card-abc] P1 Next · Not started · Product' });
    releaseStaleTaskClaim('card-abc');
    assert.equal(t.readTask('99').status, 'pending');
  } finally { t.cleanup(); }
});

test('releaseStaleTaskClaim: id-reuse guard — mapped taskId in_progress but marker belongs to a different card → left untouched', () => {
  const t = mkTaskList();
  try {
    t.writeMap({ 'card-wrong-marker': { taskId: '100' } });
    t.writeTask('100', { id: '100', status: 'in_progress', description: '[notion:some-other-card] fresh native task, id reused' });
    releaseStaleTaskClaim('card-wrong-marker');
    assert.equal(t.readTask('100').status, 'in_progress');
  } finally { t.cleanup(); }
});

test('releaseStaleTaskClaim: already-completed task is left completed (never regressed to pending)', () => {
  const t = mkTaskList();
  try {
    t.writeMap({ 'card-done': { taskId: '101' } });
    t.writeTask('101', { id: '101', status: 'completed', description: '[notion:card-done] Done' });
    releaseStaleTaskClaim('card-done');
    assert.equal(t.readTask('101').status, 'completed');
  } finally { t.cleanup(); }
});

test('releaseStaleTaskClaim: no map entry / missing files / malformed state → no-op, never throws', () => {
  const t = mkTaskList();
  try {
    assert.doesNotThrow(() => releaseStaleTaskClaim('no-such-card'));
    t.writeMap({ 'card-x': { taskId: '999' } }); // mapped taskId has no file on disk
    assert.doesNotThrow(() => releaseStaleTaskClaim('card-x'));
  } finally { t.cleanup(); }
});
