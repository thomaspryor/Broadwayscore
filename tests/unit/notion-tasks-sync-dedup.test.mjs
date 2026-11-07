// Task #1701: notion-tasks-sync.js's `pull` created TWO local task-mirror
// files (#1698 and #1699) for the SAME Notion card — cmdPull's sidecar map
// (.notion-map.json) is only persisted once, at the very end of the whole
// pull run, so a crash/thrown error after doCreate() already wrote a task
// file but before that final write leaves the map ignorant of a mirror that
// genuinely exists on disk. The next pull then re-creates it.
//
// The fix: doCreate() cross-checks a ground-truth scan of the live task
// directory (buildLiveMarkerIndex/resolveCreateTarget) before minting a new
// id, independent of what the (possibly stale) sidecar map says. These tests
// cover that scan and decision in isolation — the same "pure logic tested,
// cmdPull's Notion I/O wiring trusted" pattern the rest of this file's tests
// already use (see scripts/notion-tasks-sync.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildLiveMarkerIndex, resolveCreateTarget, writeTask, mapCardToTask } =
  require('../../scripts/notion-tasks-sync.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nts-dedup-')); }

test('resolveCreateTarget: repairs an existing live mirror instead of creating a duplicate', () => {
  const liveByMarker = new Map([['abc-123', '42']]);
  const target = resolveCreateTarget({ id: 'abc-123' }, liveByMarker);
  assert.deepEqual(target, { kind: 'repair', taskId: '42' });
});

test('resolveCreateTarget: mints a fresh id when no live mirror exists for this card', () => {
  const liveByMarker = new Map([['other-card', '9']]);
  const target = resolveCreateTarget({ id: 'abc-123' }, liveByMarker);
  assert.deepEqual(target, { kind: 'create' });
});

test('resolveCreateTarget: marker match is case-insensitive', () => {
  const liveByMarker = new Map([['abc-123', '42']]);
  assert.deepEqual(resolveCreateTarget({ id: 'ABC-123' }, liveByMarker), { kind: 'repair', taskId: '42' });
});

test('buildLiveMarkerIndex: reproduces the #1698/#1699 scenario — a card whose sidecar map entry is lost resolves to repair, not create', () => {
  const dir = tmpDir();
  const card = { id: '3be637c5-416f-8127-b0c7-c278cf1a53a0', name: 'Some card', status: 'Not started' };
  writeTask(dir, mapCardToTask(card, 1698)); // the live mirror the sidecar map "forgot"
  const index = buildLiveMarkerIndex(dir);
  const target = resolveCreateTarget(card, index.byMarker);
  assert.deepEqual(target, { kind: 'repair', taskId: '1698' }, 'must repair the existing mirror, never mint a second file');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildLiveMarkerIndex: two live files already sharing one marker resolve deterministically to the LOWEST id', () => {
  const dir = tmpDir();
  const card = { id: '3be637c5-416f-8150-98e7-cff9b98b587b', name: 'Duplicated card', status: 'Not started' };
  // Write out of order on purpose — readdirSync order is unspecified, so the
  // fix must not depend on write/iteration order to pick a winner.
  writeTask(dir, mapCardToTask(card, 1699));
  writeTask(dir, mapCardToTask(card, 1698));
  const index = buildLiveMarkerIndex(dir);
  assert.equal(index.byMarker.get(card.id), '1698');
});

test('buildLiveMarkerIndex: finds a marker pushed off line 1 by a prepended note (zombie-sweep shape)', () => {
  const dir = tmpDir();
  const card = { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Swept card', status: 'Not started' };
  const task = mapCardToTask(card, 55);
  task.description = `[zombie-sweep some note]\n${task.description}`;
  writeTask(dir, task);
  const index = buildLiveMarkerIndex(dir);
  assert.equal(index.byMarker.get(card.id), '55', 'a line-1-anchored scan would miss this — the marker must be found anywhere in the description');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildLiveMarkerIndex: ignores malformed JSON files instead of crashing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '7.json'), '{ not valid json');
  const card = { id: 'ffffffff-1111-2222-3333-444444444444', name: 'Fine card', status: 'Not started' };
  writeTask(dir, mapCardToTask(card, 8));
  const index = buildLiveMarkerIndex(dir);
  assert.equal(index.byMarker.get(card.id), '8');
  assert.equal(index.byMarker.size, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('buildLiveMarkerIndex: empty/missing directory yields an empty index, not a throw', () => {
  const index = buildLiveMarkerIndex(path.join(os.tmpdir(), 'nts-dedup-does-not-exist-xyz'));
  assert.equal(index.byMarker.size, 0);
});
