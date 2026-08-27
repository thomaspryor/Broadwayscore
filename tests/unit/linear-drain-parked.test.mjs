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
  ORPHAN_TIMEOUT_H,
  computeIssueContentHash,
  findMyJob,
  reconcileOutcomes,
  isDispatchResolved,
} = require(path.join(REPO, 'scripts', 'linear-drain-parked.js'));

const { JOB_EVENTS } = require(path.join(REPO, 'scripts', 'lib', 'dispatch-ledger.js'));

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

  test('false when the state is not backlog/unstarted (e.g. already dispatched to In Progress)', () => {
    assert.strictEqual(isAutoFiledParked(issue({ state: { name: 'In Progress', type: 'started' } })), false);
  });

  test('true for state.type "unstarted" — linear-issue-create.js\'s pickStateForMode(\'park\') fallback when a team has no backlog-type state', () => {
    assert.strictEqual(isAutoFiledParked(issue({ state: { name: 'Todo', type: 'unstarted' } })), true);
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

describe('computeIssueContentHash', () => {
  test('stable for the same title+description, changes when either changes', () => {
    const a = computeIssueContentHash(issue({ identifier: 'BRO-1' }));
    const b = computeIssueContentHash(issue({ identifier: 'BRO-1' })); // identifier not part of the hash basis
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, computeIssueContentHash(issue({ title: 'A different title' })));
    assert.notStrictEqual(a, computeIssueContentHash(issue({ description: PARKED_BODY + '\nedited.' })));
  });
});

describe('findMyJob', () => {
  test('finds the job-spawned at/after sinceTs for this taskId and follows it to a terminal state', () => {
    const entries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-26T12:00:05Z' },
      { event: JOB_EVENTS.DONE, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-26T12:05:00Z', costUSD: 0.5 },
    ];
    const job = findMyJob(entries, 'linear:BRO-1', '2026-08-26T12:00:00Z');
    assert.strictEqual(job.event, JOB_EVENTS.DONE);
    assert.strictEqual(job.jobId, 'j1');
  });

  test('returns null when no spawn is observed at/after sinceTs', () => {
    const entries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-26T11:00:00Z' }, // before sinceTs
    ];
    assert.strictEqual(findMyJob(entries, 'linear:BRO-1', '2026-08-26T12:00:00Z'), null);
  });

  test('ignores spawns for a different taskId', () => {
    const entries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-2', jobId: 'j1', ts: '2026-08-26T12:00:05Z' },
      { event: JOB_EVENTS.DONE, taskId: 'linear:BRO-2', jobId: 'j1', ts: '2026-08-26T12:05:00Z' },
    ];
    assert.strictEqual(findMyJob(entries, 'linear:BRO-1', '2026-08-26T12:00:00Z'), null);
  });
});

describe('reconcileOutcomes', () => {
  const HASH = 'deadbeefcafef00d';

  test('a job-done resolves to card-pass', () => {
    const now = new Date('2026-08-26T13:00:00Z');
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: '2026-08-26T12:00:00Z' },
    ];
    const dispatchLedgerEntries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-26T12:00:05Z' },
      { event: JOB_EVENTS.DONE, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-26T12:10:00Z' },
    ];
    const out = reconcileOutcomes(ledgerEntries, dispatchLedgerEntries, now);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].event, 'card-pass');
    assert.strictEqual(out[0].cardId, 'BRO-1');
    assert.strictEqual(out[0].contentHash, HASH);
  });

  test('a job-failed resolves to card-fail', () => {
    const now = new Date('2026-08-26T13:00:00Z');
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: '2026-08-26T12:00:00Z' },
    ];
    const dispatchLedgerEntries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-26T12:00:05Z' },
      { event: JOB_EVENTS.FAILED, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-26T12:10:00Z', stage: 'verify' },
    ];
    const out = reconcileOutcomes(ledgerEntries, dispatchLedgerEntries, now);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].event, 'card-fail');
    assert.ok(out[0].note.includes('verify'));
  });

  test('no spawn observed within ORPHAN_TIMEOUT_H resolves to card-fail (likely refused)', () => {
    const dispatchTs = '2026-08-26T09:00:00Z';
    const now = new Date(new Date(dispatchTs).getTime() + (ORPHAN_TIMEOUT_H + 1) * 3600e3);
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: dispatchTs },
    ];
    const out = reconcileOutcomes(ledgerEntries, [], now);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].event, 'card-fail');
    assert.ok(out[0].note.includes('spawn never observed'));
  });

  test('no spawn observed but still within ORPHAN_TIMEOUT_H leaves it unresolved', () => {
    const dispatchTs = '2026-08-26T09:00:00Z';
    const now = new Date(new Date(dispatchTs).getTime() + 60 * 60 * 1000); // 1h — within the window
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: dispatchTs },
    ];
    assert.deepStrictEqual(reconcileOutcomes(ledgerEntries, [], now), []);
  });

  test('a job still running (no terminal event) is left unresolved', () => {
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: '2026-08-26T12:00:00Z' },
    ];
    const dispatchLedgerEntries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-26T12:00:05Z' },
    ];
    assert.deepStrictEqual(reconcileOutcomes(ledgerEntries, dispatchLedgerEntries, new Date('2026-08-26T12:30:00Z')), []);
  });

  test('an already-resolved dispatch (same identifier+contentHash) is not re-emitted', () => {
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: '2026-08-26T12:00:00Z' },
      { event: 'card-fail', cardId: 'BRO-1', contentHash: HASH, ts: '2026-08-26T12:05:00Z' },
    ];
    assert.deepStrictEqual(reconcileOutcomes(ledgerEntries, [], new Date('2026-08-26T13:00:00Z')), []);
  });

  test('pre-feature dispatch entries with no contentHash are silently excluded', () => {
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', ts: '2026-08-26T09:00:00Z' }, // no contentHash
    ];
    assert.deepStrictEqual(reconcileOutcomes(ledgerEntries, [], new Date('2026-08-26T13:00:00Z')), []);
  });

  test('a malformed/missing ts is skipped, not treated as an immediate NaN-driven failure (ship-check Codex finding)', () => {
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: 'not-a-date' },
      { event: 'drain-parked-dispatch', identifier: 'BRO-2', contentHash: HASH }, // ts missing entirely
    ];
    assert.deepStrictEqual(reconcileOutcomes(ledgerEntries, [], new Date('2026-08-26T13:00:00Z')), []);
  });

  // ship-check Codex finding: a content-hash-keyed resolvedKeys Set (the
  // shape scripts/lib/digest-autofix.js's reconcileDigestOutcomes uses)
  // collapses two dispatches of the SAME unchanged content onto one key, so
  // the second dispatch's outcome is silently swallowed and the failure
  // streak can never reach attempt-memory's maxFailures — exactly the
  // repeated-failure case this drain exists to detect. This is the
  // regression test for that bug: TWO real dispatches on identical content,
  // each with its own terminal job, must each resolve independently.
  test('two dispatches on UNCHANGED content each resolve to their own outcome (not collapsed onto one key)', () => {
    const now = new Date('2026-08-26T20:00:00Z');
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: '2026-08-24T12:00:00Z' },
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: '2026-08-25T12:00:00Z' },
    ];
    const dispatchLedgerEntries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-24T12:00:05Z' },
      { event: JOB_EVENTS.FAILED, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-24T12:10:00Z' },
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j2', ts: '2026-08-25T12:00:05Z' },
      { event: JOB_EVENTS.FAILED, taskId: 'linear:BRO-1', jobId: 'j2', ts: '2026-08-25T12:10:00Z' },
    ];
    const out = reconcileOutcomes(ledgerEntries, dispatchLedgerEntries, now);
    assert.strictEqual(out.length, 2, 'both dispatches must independently resolve — attempt-memory needs two card-fail entries to park after 2 failures');
    assert.ok(out.every((e) => e.event === 'card-fail' && e.cardId === 'BRO-1'));
  });

  test('resolving the first of two same-content dispatches within one call does not also resolve the second (each is judged independently on its own age)', () => {
    const now = new Date('2026-08-24T15:20:00Z'); // just past ORPHAN_TIMEOUT_H for dispatch 1, well within it for dispatch 2
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: '2026-08-24T12:00:00Z' }, // 3h20m old — resolves via no-spawn-observed
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: HASH, ts: '2026-08-24T14:00:00Z' }, // 1h20m old — still within ORPHAN_TIMEOUT_H
    ];
    const out = reconcileOutcomes(ledgerEntries, [], now);
    assert.strictEqual(out.length, 1, 'only the aged-out dispatch resolves this pass; the recent one is still pending');
  });
});

describe('isDispatchResolved', () => {
  test('true once a card-fail/card-pass exists for this identifier at or after the dispatch ts', () => {
    const entries = [{ event: 'card-fail', cardId: 'BRO-1', ts: '2026-08-26T12:05:00Z' }];
    assert.strictEqual(isDispatchResolved(entries, 'BRO-1', '2026-08-26T12:00:00Z'), true);
  });

  test('false when the only resolving event predates this dispatch (an OLDER dispatch it actually resolved)', () => {
    const entries = [{ event: 'card-fail', cardId: 'BRO-1', ts: '2026-08-24T12:05:00Z' }];
    assert.strictEqual(isDispatchResolved(entries, 'BRO-1', '2026-08-25T12:00:00Z'), false);
  });

  test('false for a different identifier', () => {
    const entries = [{ event: 'card-fail', cardId: 'BRO-2', ts: '2026-08-26T12:05:00Z' }];
    assert.strictEqual(isDispatchResolved(entries, 'BRO-1', '2026-08-26T12:00:00Z'), false);
  });
});

describe('main() — permanent park integration (BRO-2434 acceptance criteria)', () => {
  test('a repeatedly-failing parked issue is skipped after 2 failed attempts on unchanged content, not re-dispatched', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const target = issue({ identifier: 'BRO-1' });
    const hash = computeIssueContentHash(target);
    // Two prior card-fail entries on the SAME content hash — checkPark's
    // default maxFailures (2) is met, so this issue must be parked.
    const ledgerEntries = [
      { event: 'card-fail', cardId: 'BRO-1', contentHash: hash, ts: '2026-08-24T12:00:00Z', note: 'job-failed' },
      { event: 'card-fail', cardId: 'BRO-1', contentHash: hash, ts: '2026-08-25T12:00:00Z', note: 'job-failed' },
    ];
    const dispatchedTaskIds = [];
    const appended = [];
    const result = await main([], {
      listOpenIssuesWithDescriptions: async () => [target],
      dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
      readLedger: () => ledgerEntries,
      appendLedger: (entry) => appended.push(entry),
      dispatchLedgerEntries: () => [],
      now: new Date('2026-08-26T12:00:00Z'),
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, []);
    assert.deepStrictEqual(dispatchedTaskIds, []);
    assert.strictEqual(appended.some((e) => e.event === 'drain-parked-dispatch'), false);
  });

  test('a resolved/successful dispatch is reconciled to card-pass and does not park', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const target = issue({ identifier: 'BRO-1' });
    const hash = computeIssueContentHash(target);
    // One prior dispatch whose child job finished cleanly (job-done) —
    // reconciliation should score this card-pass, leaving zero failures on
    // this content hash, so the issue is eligible for a fresh dispatch.
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: hash, ts: '2026-08-24T12:00:00Z' },
    ];
    const dispatchLedgerEntries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-24T12:00:05Z' },
      { event: JOB_EVENTS.DONE, taskId: 'linear:BRO-1', jobId: 'j1', ts: '2026-08-24T12:10:00Z' },
    ];
    const dispatchedTaskIds = [];
    const appended = [];
    const result = await main([], {
      listOpenIssuesWithDescriptions: async () => [target],
      dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
      readLedger: () => ledgerEntries,
      appendLedger: (entry) => appended.push(entry),
      dispatchLedgerEntries: () => dispatchLedgerEntries,
      now: new Date('2026-08-26T12:00:00Z'),
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, ['BRO-1']);
    assert.deepStrictEqual(dispatchedTaskIds, ['linear:BRO-1']);
    assert.ok(appended.some((e) => e.event === 'card-pass' && e.cardId === 'BRO-1'));
    assert.ok(appended.some((e) => e.event === 'drain-parked-dispatch' && e.identifier === 'BRO-1'));
  });

  test('two failures on DIFFERENT content hashes (issue was edited) do not park — each is a fresh attempt', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const target = issue({ identifier: 'BRO-1' });
    const currentHash = computeIssueContentHash(target);
    const ledgerEntries = [
      { event: 'card-fail', cardId: 'BRO-1', contentHash: 'stale-hash-1', ts: '2026-08-24T12:00:00Z' },
      { event: 'card-fail', cardId: 'BRO-1', contentHash: 'stale-hash-2', ts: '2026-08-25T12:00:00Z' },
    ];
    assert.notStrictEqual(currentHash, 'stale-hash-1');
    const dispatchedTaskIds = [];
    const result = await main([], {
      listOpenIssuesWithDescriptions: async () => [target],
      dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
      readLedger: () => ledgerEntries,
      appendLedger: () => {},
      dispatchLedgerEntries: () => [],
      now: new Date('2026-08-26T12:00:00Z'),
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, ['BRO-1']);
    assert.deepStrictEqual(dispatchedTaskIds, ['linear:BRO-1']);
  });

  // End-to-end version of the first test above: instead of hand-injecting
  // two pre-existing card-fail rows, this drives THREE real ticks of main()
  // through the actual reconciliation path (shared persistent ledger +
  // shared dispatch-ledger, exactly like production), so the park only
  // happens if reconcileOutcomes genuinely resolves each of the two real
  // dispatches into its own card-fail. This is the test that would have
  // caught the ship-check Codex finding (a content-hash-keyed resolvedKeys
  // Set silently swallows the second dispatch's outcome, so the streak never
  // reaches 2 and the issue is never actually parked).
  test('end-to-end: repeated real dispatches on unchanged content park on the 3rd tick, not before', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const target = issue({ identifier: 'BRO-1' });
    let ledger = [];
    let dispatchLedgerEntries = [];
    let jobCounter = 0;
    let msOffset = 0;
    const stamp = (now) => { msOffset += 1; return new Date(now.getTime() + msOffset).toISOString(); };

    async function tick(now) {
      return main([], {
        listOpenIssuesWithDescriptions: async () => [target],
        dispatchFn: (taskId) => {
          jobCounter += 1;
          const jobId = `j${jobCounter}`;
          dispatchLedgerEntries.push({ event: JOB_EVENTS.SPAWNED, taskId, jobId, ts: stamp(now) });
          dispatchLedgerEntries.push({ event: JOB_EVENTS.FAILED, taskId, jobId, ts: stamp(now), stage: 'verify' });
        },
        // A snapshot copy, matching the real fs-backed readLedger(): it
        // re-parses the file fresh on every call, so it never aliases the
        // array appendLedger pushes into. Returning the live `ledger`
        // reference here would let a later appendLedger() push in this SAME
        // tick retroactively appear in an already-captured ledgerEntries
        // variable, double-counting it.
        readLedger: () => ledger.slice(),
        appendLedger: (entry) => ledger.push({ ts: stamp(now), ...entry }),
        dispatchLedgerEntries: () => dispatchLedgerEntries,
        now,
        log: () => {},
      });
    }

    const t1 = new Date('2026-08-20T12:00:00Z');
    const r1 = await tick(t1); // no history — dispatches
    assert.deepStrictEqual(r1.dispatched, ['BRO-1']);

    // Past RETRY_COOLDOWN_MS (6h) so the cooldown alone doesn't explain what
    // happens next; the first dispatch's job already failed, so reconcile
    // resolves it to 1 card-fail before this tick's selection runs — still
    // below maxFailures(2), so it's eligible and gets dispatched again.
    const t2 = new Date(t1.getTime() + 6.2 * 3600e3);
    const r2 = await tick(t2);
    assert.deepStrictEqual(r2.dispatched, ['BRO-1']);
    assert.strictEqual(ledger.filter((e) => e.event === 'card-fail' && e.cardId === 'BRO-1').length, 1);

    // Past cooldown again; this tick's reconcile now resolves the SECOND
    // dispatch too — 2 card-fails on unchanged content — so checkPark parks
    // it and it is NOT dispatched a third time.
    const t3 = new Date(t2.getTime() + 6.2 * 3600e3);
    const r3 = await tick(t3);
    assert.deepStrictEqual(r3.dispatched, []);
    assert.strictEqual(ledger.filter((e) => e.event === 'card-fail' && e.cardId === 'BRO-1').length, 2);
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

  test('--cap threads through to selectDrainCandidates\'s limit', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const dispatchedTaskIds = [];
    const result = await main(['--cap', '1'], {
      listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' }), issue({ identifier: 'BRO-2' })],
      dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
      readLedger: () => [],
      appendLedger: () => {},
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, ['BRO-1']);
    assert.deepStrictEqual(dispatchedTaskIds, ['linear:BRO-1']);
  });

  test('a bare --cap with no value (or a non-numeric one) falls back to DISPATCH_CAP instead of silently selecting nothing', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const issues = ['BRO-1', 'BRO-2', 'BRO-3', 'BRO-4'].map((identifier) => issue({ identifier }));
    for (const argv of [['--cap'], ['--cap', 'not-a-number'], ['--cap', '0'], ['--cap', '-1']]) {
      const warnings = [];
      const dispatchedTaskIds = [];
      const result = await main(argv, {
        listOpenIssuesWithDescriptions: async () => issues,
        dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
        readLedger: () => [],
        appendLedger: () => {},
        log: (m) => warnings.push(m),
      });
      assert.strictEqual(result.dispatched.length, DISPATCH_CAP, `argv=${JSON.stringify(argv)}`);
      assert.strictEqual(dispatchedTaskIds.length, DISPATCH_CAP, `argv=${JSON.stringify(argv)}`);
      assert.ok(warnings.some((m) => m.includes('WARN --cap')), `argv=${JSON.stringify(argv)} should warn`);
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
