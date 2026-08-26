// BRO-293 — Linear-side drain for parked auto-filed issues (BRO-286 Phase 2
// completion). Per CLAUDE.md rule 15 the decision logic is NOT copied here:
// every assertion requires the real exported functions from
// scripts/lib/linear-drain-parked.js (the pure selection predicate) and
// scripts/linear-drain-parked.js (the CLI's own pure helpers + main() with
// every I/O seam injected — no live Linear API call, no real spawn, no real
// ledger file).
import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const {
  AUTO_FILED_MARKER,
  issueNumber,
  isAutoFiledParked,
  hasSafeVerifyCommand,
  selectDrainCandidates,
} = require(path.join(REPO, 'scripts', 'lib', 'linear-drain-parked.js'));

const {
  parseArgs,
  recentlyAttempted,
  main,
  DISPATCH_CAP,
  RETRY_COOLDOWN_MS,
} = require(path.join(REPO, 'scripts', 'linear-drain-parked.js'));

const SAFE_CMD = '`node --test tests/unit/some-check.test.mjs`';
const PARKED_BODY = `PARKED: Auto-filed by owner-alert-router (condition: some:condition); parked for triage.\n\n## Problem\nSomething broke.\n\n## Acceptance criteria\n${SAFE_CMD} passes.`;

function issue(overrides = {}) {
  return {
    identifier: 'BRO-100',
    title: 'Some auto-filed issue',
    description: PARKED_BODY,
    state: { name: 'Backlog', type: 'backlog' },
    ...overrides,
  };
}

describe('isAutoFiledParked', () => {
  test('true for a Backlog issue whose body carries the alert-router marker', () => {
    assert.strictEqual(isAutoFiledParked(issue()), true);
  });

  test('false when the state is not Backlog (e.g. already dispatched to In Progress)', () => {
    assert.strictEqual(isAutoFiledParked(issue({ state: { name: 'In Progress', type: 'started' } })), false);
  });

  test('false when the body has no auto-filed marker (a hand-filed Backlog issue)', () => {
    assert.strictEqual(isAutoFiledParked(issue({ description: 'PARKED: owner wants to look at this later.' })), false);
  });

  test('false for a null/missing issue or state', () => {
    assert.strictEqual(isAutoFiledParked(null), false);
    assert.strictEqual(isAutoFiledParked({ description: PARKED_BODY }), false);
  });

  test('AUTO_FILED_MARKER matches the literal string owner-alert-router.js embeds', () => {
    assert.strictEqual(AUTO_FILED_MARKER, 'Auto-filed by owner-alert-router');
  });
});

describe('hasSafeVerifyCommand', () => {
  test('true when the Acceptance criteria section has a safe-form backticked command', () => {
    assert.strictEqual(hasSafeVerifyCommand(issue()), true);
  });

  test('false when Acceptance criteria is prose only (no runnable command)', () => {
    const body = 'PARKED: Auto-filed by owner-alert-router (condition: x).\n\n## Acceptance criteria\nInvestigate and fix the root cause.';
    assert.strictEqual(hasSafeVerifyCommand(issue({ description: body })), false);
  });

  test('false when there is no Acceptance criteria section at all', () => {
    assert.strictEqual(hasSafeVerifyCommand(issue({ description: 'PARKED: Auto-filed by owner-alert-router (condition: x).' })), false);
  });

  test('false for an unsafe-form command (fails isSafeCheckCommand, e.g. outside tests/scripts/src)', () => {
    const body = '## Acceptance criteria\n`rm -rf /tmp/whatever` passes.';
    assert.strictEqual(hasSafeVerifyCommand(issue({ description: body })), false);
  });
});

describe('issueNumber', () => {
  test('extracts the trailing number for FIFO ordering', () => {
    assert.strictEqual(issueNumber('BRO-42'), 42);
    assert.strictEqual(issueNumber('BRO-7'), 7);
  });

  test('sorts numerically, not lexicographically (BRO-9 < BRO-100, which a string compare would get backwards)', () => {
    assert.ok(issueNumber('BRO-9') < issueNumber('BRO-100'));
  });

  test('unparseable identifiers sort last (Infinity)', () => {
    assert.strictEqual(issueNumber('not-an-id'), Infinity);
    assert.strictEqual(issueNumber(null), Infinity);
  });
});

describe('selectDrainCandidates', () => {
  test('filters to parked+auto-filed+verifiable issues only', () => {
    const issues = [
      issue({ identifier: 'BRO-1' }), // eligible
      issue({ identifier: 'BRO-2', state: { name: 'In Progress', type: 'started' } }), // not backlog
      issue({ identifier: 'BRO-3', description: 'PARKED: owner note, not auto-filed' }), // no marker
      issue({ identifier: 'BRO-4', description: 'PARKED: Auto-filed by owner-alert-router (condition: y); parked for triage.\n\n## Acceptance criteria\nInvestigate manually.' }), // no safe command
    ];
    const selected = selectDrainCandidates(issues);
    assert.deepStrictEqual(selected.map((i) => i.identifier), ['BRO-1']);
  });

  test('oldest (lowest issue number) first, capped at limit', () => {
    const issues = ['BRO-30', 'BRO-5', 'BRO-12', 'BRO-1'].map((identifier) => issue({ identifier }));
    const selected = selectDrainCandidates(issues, { limit: 2 });
    assert.deepStrictEqual(selected.map((i) => i.identifier), ['BRO-1', 'BRO-5']);
  });

  test('excludes identifiers in alreadyAttempted', () => {
    const issues = ['BRO-1', 'BRO-2', 'BRO-3'].map((identifier) => issue({ identifier }));
    const selected = selectDrainCandidates(issues, { alreadyAttempted: new Set(['BRO-1', 'BRO-2']) });
    assert.deepStrictEqual(selected.map((i) => i.identifier), ['BRO-3']);
  });

  test('empty/missing issues list returns []', () => {
    assert.deepStrictEqual(selectDrainCandidates([]), []);
    assert.deepStrictEqual(selectDrainCandidates(null), []);
  });

  test('default limit matches DISPATCH_CAP (3 per run)', () => {
    assert.strictEqual(DISPATCH_CAP, 3);
    const issues = ['BRO-1', 'BRO-2', 'BRO-3', 'BRO-4'].map((identifier) => issue({ identifier }));
    const selected = selectDrainCandidates(issues); // no limit passed — uses this module's own default of 3
    assert.strictEqual(selected.length, 3);
  });
});

describe('parseArgs (CLI)', () => {
  test('parses --dry-run and --cap N', () => {
    assert.deepStrictEqual(parseArgs(['--dry-run']), { _: [], 'dry-run': true });
    assert.deepStrictEqual(parseArgs(['--cap', '5']), { _: [], cap: '5' });
  });
});

describe('recentlyAttempted', () => {
  test('within cooldown window is attempted; past it is not', () => {
    const now = Date.parse('2026-08-26T12:00:00Z');
    const entries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', ts: new Date(now - 60 * 60 * 1000).toISOString() }, // 1h ago
      { event: 'drain-parked-dispatch', identifier: 'BRO-2', ts: new Date(now - RETRY_COOLDOWN_MS - 1000).toISOString() }, // just past cooldown
    ];
    const set = recentlyAttempted(entries, { now });
    assert.strictEqual(set.has('BRO-1'), true);
    assert.strictEqual(set.has('BRO-2'), false);
  });

  test('ignores unrelated event types and malformed rows', () => {
    const set = recentlyAttempted([
      { event: 'other-event', identifier: 'BRO-1', ts: new Date().toISOString() },
      { event: 'drain-parked-dispatch', identifier: null, ts: new Date().toISOString() },
      null,
    ]);
    assert.strictEqual(set.size, 0);
  });
});

describe('main() — kill switch and dispatch wiring, fully injected (no live I/O)', () => {
  test('LINEAR_NEXT_DISABLED=1 dispatches nothing and never calls the Linear client', async () => {
    const prior = process.env.LINEAR_NEXT_DISABLED;
    process.env.LINEAR_NEXT_DISABLED = '1';
    let fetchCalled = false;
    try {
      const result = await main([], {
        listOpenIssuesWithDescriptions: async () => { fetchCalled = true; return []; },
        dispatchFn: () => { throw new Error('must not dispatch'); },
        readLedger: () => [],
        appendLedger: () => { throw new Error('must not write ledger'); },
        log: () => {},
      });
      assert.deepStrictEqual(result.dispatched, []);
      assert.strictEqual(fetchCalled, false);
    } finally {
      if (prior === undefined) delete process.env.LINEAR_NEXT_DISABLED;
      else process.env.LINEAR_NEXT_DISABLED = prior;
    }
  });

  test('dispatches eligible candidates via the injected dispatchFn and journals each attempt', async () => {
    const prior = process.env.LINEAR_NEXT_DISABLED;
    delete process.env.LINEAR_NEXT_DISABLED;
    const dispatchedTaskIds = [];
    const journaled = [];
    try {
      const result = await main([], {
        listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' }), issue({ identifier: 'BRO-2' })],
        dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
        readLedger: () => [],
        appendLedger: (entry) => journaled.push(entry),
        log: () => {},
      });
      assert.deepStrictEqual(result.dispatched, ['BRO-1', 'BRO-2']);
      assert.deepStrictEqual(dispatchedTaskIds, ['linear:BRO-1', 'linear:BRO-2']);
      assert.strictEqual(journaled.length, 2);
      assert.strictEqual(journaled[0].event, 'drain-parked-dispatch');
      assert.strictEqual(journaled[0].identifier, 'BRO-1');
    } finally {
      if (prior === undefined) delete process.env.LINEAR_NEXT_DISABLED;
      else process.env.LINEAR_NEXT_DISABLED = prior;
    }
  });

  test('--dry-run previews candidates without dispatching or journaling', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    let dispatchCalled = false;
    let ledgerWritten = false;
    const result = await main(['--dry-run'], {
      listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' })],
      dispatchFn: () => { dispatchCalled = true; },
      readLedger: () => [],
      appendLedger: () => { ledgerWritten = true; },
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, []);
    assert.strictEqual(dispatchCalled, false);
    assert.strictEqual(ledgerWritten, false);
  });

  test('a Linear fetch failure is reported, not thrown, and dispatches nothing', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    // main() sets process.exitCode = 1 on this path (so a real CLI run
    // exits non-zero) — save/restore it so this assertion doesn't leak a
    // failing exit code onto the rest of THIS test file's run.
    const priorExitCode = process.exitCode;
    try {
      const result = await main([], {
        listOpenIssuesWithDescriptions: async () => { throw new Error('network down'); },
        dispatchFn: () => { throw new Error('must not dispatch'); },
        readLedger: () => [],
        appendLedger: () => {},
        log: () => {},
      });
      assert.deepStrictEqual(result.dispatched, []);
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});
