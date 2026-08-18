import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { resetPushedFlag } = require('./reconcile-dead-completions.js');
const { readMap, writeMap, isPushEligible } = require('./notion-tasks-sync.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rdc-')); }

// Card #1779: correctNotionCard() corrects a Notion card's status but never
// reset the sync-map's entry.pushed flag, so cmdPush's isPushEligible would
// skip that card forever even after the underlying task was genuinely
// completed a second time (real incident: task #1709).

test('resetPushedFlag: flips pushed true -> false and persists to disk', () => {
  const dir = tmpDir();
  writeMap(dir, { pg1: { taskId: '7', name: 'x', syncedStatus: 'Done', url: 'https://n/x', pushed: true, fmt: 1 } });

  const result = resetPushedFlag(dir, 'pg1', '7');

  assert.equal(result, 'reset');
  const onDisk = readMap(dir);
  assert.equal(onDisk.pg1.pushed, false);
  // Nothing else on the entry was touched.
  assert.equal(onDisk.pg1.taskId, '7');
  assert.equal(onDisk.pg1.syncedStatus, 'Done');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resetPushedFlag: no-ops (does not throw, does not write) when no entry exists for that pageId', () => {
  const dir = tmpDir();
  writeMap(dir, {});

  const result = resetPushedFlag(dir, 'missing-page', '7');

  assert.equal(result, 'no-entry');
  assert.deepEqual(readMap(dir), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resetPushedFlag: no-ops when the entry belongs to a different task (reused pageId guard)', () => {
  const dir = tmpDir();
  writeMap(dir, { pg1: { taskId: '99', name: 'unrelated', syncedStatus: 'Done', url: 'https://n/x', pushed: true, fmt: 1 } });

  const result = resetPushedFlag(dir, 'pg1', '7');

  assert.equal(result, 'no-entry');
  // Unrelated entry must be left completely alone.
  assert.equal(readMap(dir).pg1.pushed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resetPushedFlag: no-ops when pushed is already false', () => {
  const dir = tmpDir();
  writeMap(dir, { pg1: { taskId: '7', name: 'x', syncedStatus: 'Not started', url: 'https://n/x', pushed: false, fmt: 1 } });

  const result = resetPushedFlag(dir, 'pg1', '7');

  assert.equal(result, 'already-clear');
  assert.equal(readMap(dir).pg1.pushed, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resetPushedFlag: numeric taskId in the map matches a string taskId argument (type-coercion, not a false match)', () => {
  const dir = tmpDir();
  writeMap(dir, { pg1: { taskId: 7, name: 'x', syncedStatus: 'Done', url: 'https://n/x', pushed: true, fmt: 1 } });

  // taskId stored as a number, looked up as a string — String() coercion on
  // both sides means this SHOULD match (mapCardToTask stores string ids, but
  // callers elsewhere pass numbers straight from task-store JSON) — genuine
  // mismatches (different underlying ids) are covered by the "reused
  // pageId guard" test above.
  const result = resetPushedFlag(dir, 'pg1', '7');

  assert.equal(result, 'reset');
  fs.rmSync(dir, { recursive: true, force: true });
});

// The actual regression this card is about: a card stuck with pushed:true
// becomes push-eligible again once resetPushedFlag runs, chained straight
// into notion-tasks-sync.js's own real isPushEligible predicate (the exact
// check cmdPush's loop uses) — not a reimplementation of it.
test('resetPushedFlag + isPushEligible: a stuck card becomes re-closeable once the task is genuinely completed again', () => {
  const dir = tmpDir();
  const entry = { taskId: '7', name: 'x', syncedStatus: 'Done', url: 'https://n/x', pushed: true, fmt: 1 };
  writeMap(dir, { pg1: entry });
  const completedTask = { id: '7', status: 'completed' };

  // Before the fix in this card, the stuck entry is never push-eligible no
  // matter what the task's status is.
  assert.equal(isPushEligible(entry, completedTask), false);

  resetPushedFlag(dir, 'pg1', '7');
  const freshEntry = readMap(dir).pg1;

  assert.equal(isPushEligible(freshEntry, completedTask), true, 'cmdPush would now re-close this card instead of skipping it');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resetPushedFlag: lock contention reports lock-contention and leaves the map untouched', () => {
  const dir = tmpDir();
  writeMap(dir, { pg1: { taskId: '7', name: 'x', syncedStatus: 'Done', url: 'https://n/x', pushed: true, fmt: 1 } });
  // Simulate a concurrent sync holding the lock (same mechanism acquireLock uses).
  fs.writeFileSync(path.join(dir, '.sync-lock'), JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }));

  const result = resetPushedFlag(dir, 'pg1', '7');

  assert.equal(result, 'lock-contention');
  assert.equal(readMap(dir).pg1.pushed, true, 'a held lock must never be silently stolen mid-write');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Ship-check adversarial finding (gpt-5.4-mini): an fs error mid-write must
// report 'write-failed', not throw uncaught — a throw here would surface at
// correctNotionCard()'s call site as a misleading "Notion correction
// failed", even though the Notion status update already succeeded by the
// time resetPushedFlag runs.
test('resetPushedFlag: an fs write failure reports write-failed instead of throwing', () => {
  const dir = tmpDir();
  writeMap(dir, { pg1: { taskId: '7', name: 'x', syncedStatus: 'Done', url: 'https://n/x', pushed: true, fmt: 1 } });
  // writeMap's atomic write targets '.notion-map.json.tmp' then renames it —
  // pre-occupying that path with a directory makes the write throw EISDIR.
  fs.mkdirSync(path.join(dir, '.notion-map.json.tmp'));

  const result = resetPushedFlag(dir, 'pg1', '7');

  assert.equal(result, 'write-failed');
  assert.equal(readMap(dir).pg1.pushed, true, 'a failed write must not leave the entry half-updated');
  fs.rmSync(dir, { recursive: true, force: true });
});
