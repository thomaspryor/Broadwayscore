import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { appendEntry, readEntries, deadAttemptsForTask, launchByRef, deadBreadcrumbs, DEAD_ATTEMPT_LIMIT } = require('./dispatch-ledger.js');

function tmpLedger() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-ledger-test-')), 'ledger.jsonl');
}

test('appendEntry requires event + taskId, stamps ts, round-trips via readEntries', () => {
  const p = tmpLedger();
  assert.throws(() => appendEntry({ taskId: '1' }, p), /event/);
  assert.throws(() => appendEntry({ event: 'launch' }, p), /taskId/);
  const written = appendEntry({ event: 'launch', taskId: '297', workspaceRef: 'workspace:227' }, p);
  assert.ok(written.ts);
  const entries = readEntries(p);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].taskId, '297');
});

test('readEntries: missing file returns [], corrupt lines are skipped not fatal', () => {
  assert.deepEqual(readEntries('/nonexistent/path/ledger.jsonl'), []);
  const p = tmpLedger();
  fs.writeFileSync(p, '{"event":"launch","taskId":"1"}\nnot json\n{"event":"dead","taskId":"1","workspaceRef":"workspace:1"}\n');
  const entries = readEntries(p);
  assert.equal(entries.length, 2);
});

test('deadAttemptsForTask filters by taskId and event=dead, ignores launches', () => {
  const entries = [
    { event: 'launch', taskId: '297', workspaceRef: 'workspace:227' },
    { event: 'dead', taskId: '297', workspaceRef: 'workspace:227' },
    { event: 'dead', taskId: '297', workspaceRef: 'workspace:229' },
    { event: 'dead', taskId: '46', workspaceRef: 'workspace:5' },
  ];
  assert.equal(deadAttemptsForTask('297', entries).length, 2);
  assert.equal(deadAttemptsForTask(297, entries).length, 2); // numeric/string id agnostic
  assert.equal(deadAttemptsForTask('46', entries).length, 1);
  assert.equal(deadAttemptsForTask('999', entries).length, 0);
});

test('launchByRef finds the launch entry that produced a given workspace ref', () => {
  const entries = [
    { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227' },
    { event: 'launch', taskId: '29', subject: 'Rage clicks', workspaceRef: 'workspace:231' },
  ];
  assert.equal(launchByRef('workspace:227', entries).taskId, '297');
  assert.equal(launchByRef('workspace:404', entries), null);
});

test('DEAD_ATTEMPT_LIMIT is 2 — matches the real incident (2 dead shells existed before the 3rd)', () => {
  assert.equal(DEAD_ATTEMPT_LIMIT, 2);
});

test('deadBreadcrumbs: only idle workspaces with a matching launch record produce breadcrumbs', () => {
  const entries = [
    { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227' },
  ];
  const idle = [
    { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' },       // dead auto-dispatch — should breadcrumb
    { ref: 'workspace:900', title: 'Some manually opened tab' },    // never launched by bsc-next — skip
  ];
  const bc = deadBreadcrumbs(idle, entries);
  assert.equal(bc.length, 1);
  assert.equal(bc[0].event, 'dead');
  assert.equal(bc[0].taskId, '297');
  assert.equal(bc[0].workspaceRef, 'workspace:227');
});

test('deadBreadcrumbs is idempotent — a workspace already marked dead does not re-breadcrumb', () => {
  const entries = [
    { event: 'launch', taskId: '297', workspaceRef: 'workspace:227' },
    { event: 'dead', taskId: '297', workspaceRef: 'workspace:227' },
  ];
  const idle = [{ ref: 'workspace:227', title: 'T1-retrieval Sprint 2' }];
  assert.deepEqual(deadBreadcrumbs(idle, entries), []);
});

test('deadBreadcrumbs across repeated sweeps: second sweep sees the first sweep\'s writes and stops re-flagging', () => {
  const entries = [{ event: 'launch', taskId: '297', workspaceRef: 'workspace:227' }];
  const idle = [{ ref: 'workspace:227', title: 'T1-retrieval Sprint 2' }];
  const firstSweep = deadBreadcrumbs(idle, entries);
  assert.equal(firstSweep.length, 1);
  const afterWrite = [...entries, ...firstSweep];
  const secondSweep = deadBreadcrumbs(idle, afterWrite);
  assert.equal(secondSweep.length, 0);
});
