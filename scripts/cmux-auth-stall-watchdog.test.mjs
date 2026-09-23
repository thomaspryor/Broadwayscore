import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scanOnce, leadingGlyph, stripManagedGlyph } = require('./cmux-auth-stall-watchdog.js');

function noopLog() {}

// BRO-4065: scanOnce now tries to REPAIR a logged-out tab before marking it.
// Every call below stubs the repair + its rate-limit/state I/O so no test ever
// touches a real tab or writes into ~/.claude/state (the repair defaults are
// real). Individual tests override healFn to exercise the repair path.
const HEAL_STUBS = {
  healFn: () => ({ healed: false, reason: 'stubbed repair failure' }),
  lastHealAttemptFn: () => null,
  recordHealAttemptFn: () => {},
  readStateFn: () => null,
  clearStateFn: () => {},
};

// Every ref below uses an obviously-fake "test-N" suffix, NEVER a small
// integer — this machine's real cmux workspaces are numbered that way, and a
// test that forgets to override writeStateFn falls through to scanOnce's
// REAL fs.writeFileSync into ~/.claude/state/needs-you/. That happened once
// while developing this file (a workspace:6 collision wrote live garbage
// into this machine's real needs-you state, caught and cleaned up by hand)
// — an obviously-fake ref at least keeps a repeat of that mistake harmless.
// Every test that can reach the write path also supplies writeStateFn.

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
    ...HEAL_STUBS,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:test-1', title: '🧭 Some auto-dispatched task' }],
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
  assert.equal(written[0].ref, 'workspace:test-1');
  assert.match(written[0].state.question, /lost its login/);
  assert.doesNotMatch(written[0].state.question, /\/login|CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(written[0].state.agentRemedy, /relaunch-claude-tab\.js --workspace workspace:test-1/);
});

test('scanOnce: dry-run reports the hit but renames/writes nothing', () => {
  const renamed = [];
  const written = [];
  const { marked } = scanOnce({
    ...HEAL_STUBS,
    dryRun: true,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:test-2', title: 'Some tab' }],
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
    ...HEAL_STUBS,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:test-3', title: '❓ Already flagged' }],
    runFn: (args) => { if (args[0] === 'read-screen') readScreenCalls++; return ''; },
  });
  assert.equal(readScreenCalls, 0);
  assert.equal(marked.length, 0);
});

test('scanOnce: a healthy workspace is left untouched', () => {
  const renamed = [];
  const { marked } = scanOnce({
    ...HEAL_STUBS,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:test-4', title: 'Healthy tab' }],
    runFn: (args) => {
      if (args[0] === 'read-screen') return '🤖 SONNET │ ctx 30% │ main │ Broadwayscore\n\nDone: shipped.';
      renamed.push(args);
      return '';
    },
  });
  assert.equal(marked.length, 0);
  assert.equal(renamed.length, 0);
});

test('scanOnce: TOCTOU — re-checks the CURRENT screen right before the write, not just identity', () => {
  // Second-opinion + Codex adversarial review both flagged the original
  // identity-only re-check (ref still exists, still un-❓) as insufficient:
  // the pane could have recovered (logged back in, or produced real output)
  // during the read-screen call's own multi-attempt auth-retry ladder, and
  // writing based on the FIRST screen read alone would mark a tab that is no
  // longer actually stuck. scanOnce now re-runs detectAuthStall against a
  // FRESH read-screen at write time and aborts if the condition no longer
  // holds.
  const renamed = [];
  let screenCalls = 0;
  const { marked } = scanOnce({
    ...HEAL_STUBS,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:test-5', title: 'Recovering tab' }],
    runFn: (args) => {
      if (args[0] === 'read-screen') {
        screenCalls++;
        // First read (the scan): still stuck. Second read (right before the
        // write): the session came back on its own.
        return screenCalls === 1
          ? 'Not logged in · Please run /login'
          : '🤖 SONNET │ ctx 12% │ main │ Broadwayscore\n\nBack online, resuming work.';
      }
      renamed.push(args);
      return '';
    },
  });
  assert.equal(marked.length, 1, 'the scan itself still reports the hit it observed');
  assert.equal(renamed.length, 0, 'but the write is aborted once the fresh re-check finds it recovered');
});

test('scanOnce: TOCTOU — re-list right before the write; a title changed since the scan wins over the stale one', () => {
  const renamed = [];
  const written = [];
  let listCalls = 0;
  scanOnce({
    ...HEAL_STUBS,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => {
      listCalls++;
      // First call (the scan) sees the stale title; the re-list right
      // before the write sees a title the owner renamed in between.
      const title = listCalls === 1 ? 'Old title' : 'Owner-renamed title';
      return [{ ref: 'workspace:test-6', title }];
    },
    runFn: (args) => {
      if (args[0] === 'read-screen') return 'Not logged in · Please run /login';
      if (args[0] === 'workspace-action') { renamed.push(args); return ''; }
      throw new Error(`unexpected cmux call: ${args.join(' ')}`);
    },
    writeStateFn: (ref, state) => written.push({ ref, state }),
  });
  assert.equal(renamed[0][renamed[0].indexOf('--title') + 1], '❓ Owner-renamed title');
});

test('scanOnce: TOCTOU — ref vanished by write time is skipped, not renamed', () => {
  const renamed = [];
  let listCalls = 0;
  scanOnce({
    ...HEAL_STUBS,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => {
      listCalls++;
      return listCalls === 1 ? [{ ref: 'workspace:test-7', title: 'Doomed tab' }] : [];
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
    ...HEAL_STUBS,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => {
      listCalls++;
      const title = listCalls === 1 ? 'Racing tab' : '❓ Racing tab';
      return [{ ref: 'workspace:test-8', title }];
    },
    runFn: (args) => {
      if (args[0] === 'read-screen') return 'Not logged in · Please run /login';
      renamed.push(args);
      return '';
    },
  });
  assert.equal(renamed.length, 0);
});

test('scanOnce: never overwrites an EXISTING needs-you state file (another writer already owns this ref)', () => {
  // Codex review finding: a concurrent Stop-hook DECISION NEEDED write and
  // this watchdog's write are not coordinated by anything. If a real
  // captured question already exists for this ref, this watchdog must not
  // clobber it with a generic recovery message — it only writes when there
  // is nothing there yet.
  const written = [];
  scanOnce({
    ...HEAL_STUBS,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:test-9', title: 'Racing with the Stop hook' }],
    runFn: (args) => {
      if (args[0] === 'read-screen') return 'Not logged in · Please run /login';
      return '';
    },
    stateExistsFn: () => true,
    writeStateFn: (ref, state) => written.push({ ref, state }),
  });
  assert.equal(written.length, 0);
});

test('scanOnce: a read-screen error is fail-safe (skip, never mark)', () => {
  const { marked, scanned } = scanOnce({
    ...HEAL_STUBS,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:test-10', title: 'Flaky tab' }],
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

// ---- BRO-4065: auto-heal ----

function healHarness({ title = '🧭 Task', screen = 'Not logged in · Please run /login', healResult = { healed: true, reason: 'ok' }, lastAttempt = null, state = null, dryRun = false } = {}) {
  const calls = { heal: [], rename: [], written: [], cleared: [], recorded: [] };
  const result = scanOnce({
    ...HEAL_STUBS,
    dryRun,
    log: noopLog,
    cmuxAvailableFn: () => true,
    listWorkspacesFn: () => [{ ref: 'workspace:test-h', title }],
    runFn: (args) => {
      if (args[0] === 'read-screen') return screen;
      if (args[0] === 'workspace-action') { calls.rename.push(args[args.indexOf('--title') + 1]); return ''; }
      throw new Error(`unexpected cmux call: ${args.join(' ')}`);
    },
    writeStateFn: (ref, st) => calls.written.push(st),
    readStateFn: () => state,
    clearStateFn: (ref) => calls.cleared.push(ref),
    healFn: (ref) => { calls.heal.push(ref); return healResult; },
    lastHealAttemptFn: () => lastAttempt,
    recordHealAttemptFn: (ref, r) => calls.recorded.push(r),
    now: () => 10 * 60 * 60 * 1000,
  });
  return { result, calls };
}

test('heal: a logged-out tab that repairs is NOT marked ❓', () => {
  const { result, calls } = healHarness();
  assert.deepEqual(calls.heal, ['workspace:test-h']);
  assert.equal(result.healed.length, 1);
  assert.equal(result.marked.length, 0);
  assert.equal(calls.rename.length, 0);
  assert.equal(calls.written.length, 0);
  // attempt recorded before the outcome, then the outcome
  assert.equal(calls.recorded.length, 2);
  assert.equal(calls.recorded[1].healed, true);
});

test('heal: a failed repair falls back to ❓ with plain-English text', () => {
  const { result, calls } = healHarness({ healResult: { healed: false, reason: 'normal prompt never came back' } });
  assert.equal(calls.heal.length, 1);
  assert.equal(result.marked.length, 1);
  assert.deepEqual(calls.rename, ['❓ Task']);
  assert.match(calls.written[0].question, /couldn't be restarted automatically/);
  assert.doesNotMatch(calls.written[0].question, /\/login/);
});

test('heal: rate limit — a tab tried <30 min ago is not retried, just marked', () => {
  const now = 10 * 60 * 60 * 1000;
  const { result, calls } = healHarness({ lastAttempt: now - 10 * 60 * 1000 });
  assert.equal(calls.heal.length, 0);
  assert.equal(result.marked.length, 1);
});

test('heal: rate limit — a tab tried >30 min ago is retried', () => {
  const now = 10 * 60 * 60 * 1000;
  const { calls } = healHarness({ lastAttempt: now - 31 * 60 * 1000 });
  assert.equal(calls.heal.length, 1);
});

test('heal: a ❓ tab THIS watchdog marked logged-out is retried and un-marked on success', () => {
  const { result, calls } = healHarness({
    title: '❓ Task',
    state: { source: 'cmux-auth-stall-watchdog', kind: 'logged-out' },
  });
  assert.equal(calls.heal.length, 1);
  assert.equal(result.healed.length, 1);
  assert.deepEqual(calls.rename, ['Task']);
  assert.deepEqual(calls.cleared, ['workspace:test-h']);
});

test('heal: a ❓ tab owned by someone else (DECISION NEEDED) is never touched', () => {
  const { calls } = healHarness({ title: '❓ Task', state: { question: 'Pick A or B' } });
  assert.equal(calls.heal.length, 0);
  assert.equal(calls.rename.length, 0);
  assert.equal(calls.cleared.length, 0);
});

test('heal: a ❓ stalled-resume mark is not a repair candidate', () => {
  const { calls } = healHarness({ title: '❓ Task', state: { source: 'cmux-auth-stall-watchdog', kind: 'stalled-resume' } });
  assert.equal(calls.heal.length, 0);
});

test('heal: stalled-resume tabs are only marked, never relaunched', () => {
  const { result, calls } = healHarness({ screen: 'No response requested.' });
  assert.equal(calls.heal.length, 0);
  assert.equal(result.marked.length, 1);
});

test('heal: dry-run never relaunches anything', () => {
  const { calls } = healHarness({ dryRun: true });
  assert.equal(calls.heal.length, 0);
  assert.equal(calls.rename.length, 0);
});

test('heal: a repair that throws is treated as a failure and the tab is marked', () => {
  const { result } = healHarness({ healResult: null });
  // healResult null → healFn returns null → handled as not healed
  assert.equal(result.marked.length, 1);
});
