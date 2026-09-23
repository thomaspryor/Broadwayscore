import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scanOnce, leadingGlyph, stripManagedGlyph } = require('./cmux-auth-stall-watchdog.js');

function noopLog() {}

test('leadingGlyph: only a leading ❓ within the glyph zone counts', () => {
  assert.equal(leadingGlyph('❓ Fix the thing'), '❓');
  assert.equal(leadingGlyph('✅ Fix the thing'), null);
  assert.equal(leadingGlyph('A question ❓ later'), null);
});

test('stripManagedGlyph: strips a leading ✅/❓/🧭, leaves the rest untouched', () => {
  assert.equal(stripManagedGlyph('✅ Fix the thing'), 'Fix the thing');
  assert.equal(stripManagedGlyph('🧭 Auto dispatch task'), 'Auto dispatch task');
  assert.equal(stripManagedGlyph('Plain title'), 'Plain title');
});

test('scanOnce: marks a logged-out workspace — renames and writes state', () => {
  const renamed = [];
  const written = [];
  const { scanned, marked } = scanOnce({
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:1', title: '🧭 Some auto-dispatched task' }],
    runFn: (args) => {
      if (args[0] === 'read-screen') return 'Not logged in · Please run /login';
      if (args[0] === 'workspace-action') { renamed.push(args); return ''; }
      throw new Error(`unexpected cmux call: ${args.join(' ')}`);
    },
    writeStateFn: (ref, state) => written.push({ ref, state }),
  });
  assert.equal(scanned, 1);
  assert.equal(marked.length, 1);
  assert.equal(marked[0].kind, 'logged-out');
  assert.equal(renamed.length, 1);
  assert.equal(renamed[0][renamed[0].indexOf('--title') + 1], '❓ Some auto-dispatched task');
  assert.equal(written.length, 1);
  assert.equal(written[0].ref, 'workspace:1');
  assert.match(written[0].state.question, /Not logged in/);
});

test('scanOnce: dry-run reports the hit but renames/writes nothing', () => {
  const renamed = [];
  const written = [];
  const { marked } = scanOnce({
    dryRun: true,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:2', title: 'Some tab' }],
    runFn: (args) => {
      if (args[0] === 'read-screen') return 'No response requested.';
      renamed.push(args);
      return '';
    },
    writeStateFn: (ref, state) => written.push({ ref, state }),
  });
  assert.equal(marked.length, 1);
  assert.equal(marked[0].kind, 'stalled-resume');
  assert.equal(renamed.length, 0);
  assert.equal(written.length, 0);
});

test('scanOnce: already ❓-marked tabs are skipped (never re-read, never stomped)', () => {
  let readScreenCalls = 0;
  const { marked } = scanOnce({
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:3', title: '❓ Already flagged' }],
    runFn: (args) => { if (args[0] === 'read-screen') readScreenCalls++; return ''; },
  });
  assert.equal(readScreenCalls, 0);
  assert.equal(marked.length, 0);
});

test('scanOnce: a healthy workspace is left untouched', () => {
  const renamed = [];
  const { marked } = scanOnce({
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:4', title: 'Healthy tab' }],
    runFn: (args) => {
      if (args[0] === 'read-screen') return '🤖 SONNET │ ctx 30% │ main │ Broadwayscore\n\nDone: shipped.';
      renamed.push(args);
      return '';
    },
  });
  assert.equal(marked.length, 0);
  assert.equal(renamed.length, 0);
});

test('scanOnce: TOCTOU — re-list right before the write; a title changed since the scan wins over the stale one', () => {
  const renamed = [];
  let listCalls = 0;
  scanOnce({
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => {
      listCalls++;
      // First call (the scan) sees the stale title; the re-list right
      // before the write sees a title the owner renamed in between.
      const title = listCalls === 1 ? 'Old title' : 'Owner-renamed title';
      return [{ ref: 'workspace:6', title }];
    },
    runFn: (args) => {
      if (args[0] === 'read-screen') return 'Not logged in · Please run /login';
      if (args[0] === 'workspace-action') { renamed.push(args); return ''; }
      throw new Error(`unexpected cmux call: ${args.join(' ')}`);
    },
  });
  assert.equal(renamed[0][renamed[0].indexOf('--title') + 1], '❓ Owner-renamed title');
});

test('scanOnce: TOCTOU — ref vanished by write time is skipped, not renamed', () => {
  const renamed = [];
  let listCalls = 0;
  scanOnce({
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => {
      listCalls++;
      return listCalls === 1 ? [{ ref: 'workspace:7', title: 'Doomed tab' }] : [];
    },
    runFn: (args) => {
      if (args[0] === 'read-screen') return 'Not logged in · Please run /login';
      renamed.push(args);
      return '';
    },
  });
  assert.equal(renamed.length, 0);
});

test('scanOnce: TOCTOU — already ❓-marked by the time of the write is skipped, not double-prefixed', () => {
  const renamed = [];
  let listCalls = 0;
  scanOnce({
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => {
      listCalls++;
      const title = listCalls === 1 ? 'Racing tab' : '❓ Racing tab';
      return [{ ref: 'workspace:8', title }];
    },
    runFn: (args) => {
      if (args[0] === 'read-screen') return 'Not logged in · Please run /login';
      renamed.push(args);
      return '';
    },
  });
  assert.equal(renamed.length, 0);
});

test('scanOnce: a read-screen error is fail-safe (skip, never mark)', () => {
  const { marked, scanned } = scanOnce({
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:5', title: 'Flaky tab' }],
    runFn: (args) => { if (args[0] === 'read-screen') throw new Error('internal_error: Failed to read terminal text'); return ''; },
  });
  assert.equal(scanned, 1);
  assert.equal(marked.length, 0);
});

test('scanOnce: cmux unavailable returns zero scanned, no throw', () => {
  const { scanned, marked } = scanOnce({ log: noopLog, cmuxAvailableFn: () => false });
  assert.equal(scanned, 0);
  assert.equal(marked.length, 0);
});
