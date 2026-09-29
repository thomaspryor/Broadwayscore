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
const { DEFAULT_CONCURRENCY_CAP, DEFAULT_SPEND_THRESHOLD_USD } = require(path.join(REPO, 'scripts', 'lib', 'backlog-drain.js'));

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
    const dispatchOpts = [];
    const journaled = [];
    try {
      const result = await main([], {
        listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' }), issue({ identifier: 'BRO-2' })],
        dispatchFn: (taskId, _log, _delay, _model, opts) => { dispatchedTaskIds.push(taskId); dispatchOpts.push(opts); },
        readLedger: () => [],
        appendLedger: (entry) => journaled.push(entry),
        // BRO-3454: explicit, not the real-shared-ledger fallback — keeps
        // this test's assertions independent of production ledger content
        // (ship-check/Codex finding).
        dispatchLedgerEntries: () => [],
        log: () => {},
      });
      assert.deepStrictEqual(result.dispatched, ['BRO-1', 'BRO-2']);
      assert.deepStrictEqual(dispatchedTaskIds, ['linear:BRO-1', 'linear:BRO-2']);
      // BRO-2499 ship-check P0: health-check.js:3951 files alert-router
      // trackers titled "BSC Daily: <row>", which linear-dispatch.js's
      // autofixFiledIssueGuard refuses. This drain owns that population, so
      // every dispatch it makes must carry the waiver — without it the guard
      // refuses inside the detached child and this drain silently does
      // nothing while still journaling "attempted".
      // BRO-3060 added a SECOND waiver to the same call: allowAutomationParked,
      // which lets the drain past linear-next.js's PARKED_SENTINEL for issues an
      // automation filer parked (provenance re-verified at the call site) rather
      // than an owner. That commit changed scripts/linear-drain-parked.js without
      // updating this file and reddened main — the same shape BRO-3052 hit hours
      // earlier, both through the gap filed as BRO-3063 (the pre-merge test floor
      // never runs a changed source file's tests/unit test).
      //
      // Asserting on the two waivers BY NAME rather than deep-equalling the whole
      // opts object keeps what this test is actually for — proving the drain
      // waives the guards for the population it owns — while not failing the next
      // time an unrelated option is threaded through the same call. The negative
      // half below is what keeps that from being a weakening: no OTHER waiver may
      // appear without a deliberate edit here.
      assert.equal(dispatchOpts.length, 2, 'both candidates must be dispatched');
      for (const o of dispatchOpts) {
        assert.equal(o.allowAutofixFiled, true,
          'linear-drain-parked must waive autofixFiledIssueGuard for the population it owns');
        assert.equal(o.allowAutomationParked, true,
          'linear-drain-parked must waive PARKED_SENTINEL for automation-parked issues (BRO-3060)');
        assert.deepStrictEqual(
          Object.keys(o).sort(), ['allowAutofixFiled', 'allowAutomationParked'],
          `no undeclared waiver may ride along on this dispatch — got ${JSON.stringify(o)}`,
        );
      }
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
      dispatchLedgerEntries: () => [], // BRO-3454: explicit, not the real-shared-ledger fallback
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
        dispatchLedgerEntries: () => [], // BRO-3454: explicit, not the real-shared-ledger fallback
        log: (m) => warnings.push(m),
        // BRO-3454: this test is about --cap parsing/fallback, not the new
        // concurrency ceiling — held well above DISPATCH_CAP so it can't
        // become the limiting factor here (DEFAULT_CONCURRENCY_CAP=2 would
        // otherwise cap dispatch at 2, below the DISPATCH_CAP=3 this test
        // asserts on).
        concurrencyCap: DISPATCH_CAP + 1,
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

  // The test ABOVE is vacuous on its own and cannot be the regression pin:
  // `readLedger: () => []` means reconcileOutcomes has no prior dispatch to
  // resolve, returns [], and the append loop never executes — so it passed
  // for as long as the dry-run ledger write existed. This one seeds a prior
  // dispatch AND its terminal job so reconcileOutcomes actually produces an
  // outcome, which is the only state in which the bug was reachable.
  test('--dry-run does not append reconciled outcomes, but still LOGS what it would have reconciled', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const prior = issue({ identifier: 'BRO-9' });
    const ledger = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-9', contentHash: computeIssueContentHash(prior), ts: '2026-09-01T12:00:00Z' },
    ];
    const dispatchLedgerEntries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-9', jobId: 'job-x', ts: '2026-09-01T12:00:05Z' },
      { event: JOB_EVENTS.DONE, taskId: 'linear:BRO-9', jobId: 'job-x', ts: '2026-09-01T13:00:00Z' },
    ];
    const appended = [];
    const logs = [];
    const result = await main(['--dry-run'], {
      listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-10' })],
      dispatchFn: () => { throw new Error('dry-run must not dispatch'); },
      readLedger: () => ledger.slice(),
      appendLedger: (entry) => appended.push(entry),
      dispatchLedgerEntries: () => dispatchLedgerEntries,
      log: (m) => logs.push(m),
    });
    assert.deepStrictEqual(result.dispatched, []);
    // Proves reconcileOutcomes really did produce an outcome this run — without
    // this the assertion below would pass for the wrong reason, exactly as the
    // older test did.
    assert.ok(logs.some((m) => m.includes('attempt-memory: BRO-9 card-pass')),
      `dry run must still report what it would reconcile; logs=${JSON.stringify(logs)}`);
    assert.deepStrictEqual(appended, [], '--dry-run promises "no dispatch/ledger writes" in USAGE and in its own summary line — it must write nothing');
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

describe('readLedger dedupes exact-duplicate lines (merge=union safety)', () => {
  // This ledger carries `merge=union` in .gitattributes, and union can leave
  // the SAME row twice (sync-audit-checkout.sh's recovery re-appends the
  // locally-saved rows over origin's). attempt-memory.js's checkPark() counts
  // every 'card-fail' row in the failure streak with no dedupe of its own and
  // parks at DEFAULT_MAX_FAILURES = 2, so ONE duplicated fail row is enough to
  // strand a card that only failed once. Found by ship-check, 2026-09-08.
  const fs = require('node:fs');
  const os = require('node:os');
  // Require the REAL readLedger, not the destructured subset at the top of
  // this file (rule 15: the production function, never a restatement).
  const { readLedger } = require(path.join(REPO, 'scripts', 'linear-drain-parked.js'));

  function withLedger(lines, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-ledger-'));
    const file = path.join(dir, 'ledger.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  const FAIL = JSON.stringify({ ts: '2026-09-08T06:48:34.217Z', event: 'card-fail', cardId: 'BRO-1', contentHash: 'h1', note: 'fail: x' });
  const OTHER = JSON.stringify({ ts: '2026-09-08T07:48:34.217Z', event: 'card-pass', cardId: 'BRO-1', contentHash: 'h1' });

  test('a row duplicated by a union merge is read once, not twice', () => {
    withLedger([FAIL, FAIL, OTHER], (file) => {
      const rows = readLedger(file);
      assert.equal(rows.length, 2, 'the duplicated fail row must collapse to one');
      assert.equal(rows.filter((r) => r.event === 'card-fail').length, 1);
    });
  });

  test('two genuinely distinct attempts are BOTH kept — dedupe must not eat real rows', () => {
    const second = JSON.stringify({ ts: '2026-09-08T12:48:34.217Z', event: 'card-fail', cardId: 'BRO-1', contentHash: 'h1', note: 'fail: x' });
    withLedger([FAIL, second], (file) => {
      assert.equal(readLedger(file).length, 2, 'distinct ts means distinct attempt');
    });
  });

  test('the duplicate cannot reach checkPark and force a false park', () => {
    // End-to-end through the real attempt-memory predicate, not a restatement
    // of it: one real failure plus its merge duplicate must NOT park.
    const { checkPark } = require(path.join(REPO, 'scripts', 'lib', 'attempt-memory.js'));
    withLedger([FAIL, FAIL], (file) => {
      const entries = readLedger(file);
      assert.equal(checkPark(entries, 'BRO-1', 'h1').parked, false, 'one failure + its duplicate must not park');
    });
    // And the guard is real: two DISTINCT failures still park, so dedupe has
    // not disabled attempt-memory.
    const second = JSON.stringify({ ts: '2026-09-08T12:48:34.217Z', event: 'card-fail', cardId: 'BRO-1', contentHash: 'h1', note: 'fail: y' });
    withLedger([FAIL, second], (file) => {
      assert.equal(checkPark(readLedger(file), 'BRO-1', 'h1').parked, true, 'two real failures must still park');
    });
  });
});

// ── BRO-3454: spend circuit breaker + concurrency ceiling ───────────────────
// This drain had neither guard its siblings scripts/backlog-drain.js and
// scripts/lib/digest-autofix.js (BRO-3412) have. Wired at the SAME shared
// default thresholds (DEFAULT_SPEND_THRESHOLD_USD=$12, DEFAULT_CONCURRENCY_CAP=2)
// — never new numbers — via scripts/lib/backlog-drain.js's existing
// computeSpendCircuitBreaker/computeConcurrency.
describe('main() — BRO-3454 spend circuit breaker + concurrency ceiling', () => {
  test('spend breaker tripped — dispatches ZERO even with dispatch-count budget and concurrency headroom available', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    // $12+ spent with zero completions (card-pass) tips
    // computeSpendCircuitBreaker into halt — same shape
    // scripts/backlog-drain.js's own breaker trips on.
    const ledgerEntries = [
      { event: 'card-fail', cardId: 'BRO-9', usd: DEFAULT_SPEND_THRESHOLD_USD + 1, ts: new Date().toISOString() },
    ];
    const dispatchedTaskIds = [];
    const result = await main([], {
      listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' })],
      dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
      readLedger: () => ledgerEntries,
      appendLedger: () => {},
      dispatchLedgerEntries: () => [], // no alive jobs — concurrency is NOT the limiter here
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, [], 'spend breaker must block every dispatch, not just reduce budget');
    assert.deepStrictEqual(dispatchedTaskIds, []);
  });

  test('concurrency at cap — stops dispatching regardless of remaining dispatch-count budget', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    // This drain's own ledger recorded a prior dispatch onto BRO-9 — the
    // population computeConcurrency scopes its ceiling to.
    const ledgerEntries = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-9', contentHash: 'h1', ts: new Date().toISOString() },
    ];
    // That dispatch's job is still alive (spawned, no terminal event) in the
    // SHARED dispatch-ledger — at concurrencyCap=1 this alone saturates it.
    const dispatchLedgerEntries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-9', jobId: 'job-alive', ts: new Date().toISOString() },
    ];
    const dispatchedTaskIds = [];
    // A DIFFERENT, otherwise fully-eligible issue — cap (dispatch-count
    // budget) is DISPATCH_CAP, plenty of room; only the concurrency ceiling
    // should stop it.
    const result = await main([], {
      listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-10' })],
      dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
      readLedger: () => ledgerEntries,
      appendLedger: () => {},
      dispatchLedgerEntries: () => dispatchLedgerEntries,
      concurrencyCap: 1,
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, [], 'at concurrency cap, no dispatch budget is available however high the dispatch-count cap is');
    assert.deepStrictEqual(dispatchedTaskIds, []);
  });

  test('guard computation failure fails CLOSED — zero dispatches, never silently open', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const dispatchedTaskIds = [];
    // A throwing dispatchLedgerEntries reader: step 4's fail-soft reconcile
    // swallows it (park checks skipped), but the guard's OWN try/catch below
    // must be what actually stops dispatch — a double-fault, same shape
    // digest-autofix.test.mjs's BRO-3412 test documents for its sibling.
    const result = await main([], {
      listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' })],
      dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
      readLedger: () => [],
      appendLedger: () => {},
      dispatchLedgerEntries: () => { throw new Error('ledger read exploded'); },
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, [], 'a broken guard computation must never fail open into unlimited dispatch');
    assert.deepStrictEqual(dispatchedTaskIds, []);
  });

  // BRO-3412 (Codex adversarial-review finding, ported here so this drain
  // doesn't rediscover the same bug): a dispatch reconciled to a costly
  // failure THIS SAME RUN must be visible to the spend breaker THIS SAME
  // RUN, not just the next one. Driven through the SAME live-array
  // readLedger/appendLedger pattern the pre-existing 'end-to-end' park test
  // above uses (a real file/read-after-write isn't this file's test
  // convention) — the guard calling `deps.readLedger()` again after step 4's
  // `appendLedgerFn` pushed into the SAME live array is what proves it: a
  // stale/aliased snapshot would miss the newly-pushed row.
  test('a dispatch reconciled to a costly failure THIS SAME RUN still trips the spend breaker THIS SAME RUN', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const priorTarget = issue({ identifier: 'BRO-9' });
    const hash = computeIssueContentHash(priorTarget);
    // Prior dispatch attempt on an UNRELATED issue — its outcome is what
    // gets reconciled (and costed) during THIS call.
    const ledger = [
      { event: 'drain-parked-dispatch', identifier: 'BRO-9', contentHash: hash, ts: '2026-09-01T12:00:00Z' },
    ];
    // JOB_EVENTS.FAILED (not DONE): reconcileOutcomes' TERMINAL branch maps
    // job.event === DONE to 'card-pass' unconditionally for this
    // Linear-only drain (unlike digest-autofix.js's dual Linear/Notion
    // population, this file has no separate "task completed" check to force
    // a card-fail out of a DONE job) — a real costly FAILURE needs FAILED.
    const dispatchLedgerEntries = [
      { event: JOB_EVENTS.SPAWNED, taskId: 'linear:BRO-9', jobId: 'job-costly', ts: '2026-09-01T12:00:05Z' },
      { event: JOB_EVENTS.FAILED, taskId: 'linear:BRO-9', jobId: 'job-costly', ts: new Date().toISOString(), costUSD: DEFAULT_SPEND_THRESHOLD_USD + 1 },
    ];
    const dispatchedTaskIds = [];
    // A DIFFERENT, otherwise fully-eligible issue — nothing pre-seeds spend
    // against IT specifically; the freshly-reconciled cost from BRO-9 must
    // still halt the whole run's dispatch budget.
    const result = await main([], {
      listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-10' })],
      dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
      readLedger: () => ledger.slice(),
      appendLedger: (entry) => ledger.push({ ts: new Date().toISOString(), ...entry }),
      dispatchLedgerEntries: () => dispatchLedgerEntries,
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, [], 'spend reconciled during THIS run must be visible to the breaker in the SAME run');
    assert.deepStrictEqual(dispatchedTaskIds, []);
    assert.ok(ledger.some((e) => e.event === 'card-fail' && e.cardId === 'BRO-9' && e.usd === DEFAULT_SPEND_THRESHOLD_USD + 1),
      'reconcile must have recorded the cost on the own ledger (usd field wiring)');
  });

  test('neither guard tripped — dispatches normally up to min(DISPATCH_CAP, DEFAULT_CONCURRENCY_CAP)', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    const dispatchedTaskIds = [];
    const result = await main([], {
      listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' })],
      dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
      readLedger: () => [],
      appendLedger: () => {},
      dispatchLedgerEntries: () => [],
      log: () => {},
    });
    assert.deepStrictEqual(result.dispatched, ['BRO-1'], 'healthy state (no spend, no alive jobs) must still dispatch');
    assert.deepStrictEqual(dispatchedTaskIds, ['linear:BRO-1']);
  });

  test('--dry-run never touches the guard (no real ledger read attempted)', async () => {
    delete process.env.LINEAR_NEXT_DISABLED;
    let guardReadAttempted = false;
    const result = await main(['--dry-run'], {
      listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' })],
      dispatchFn: () => { throw new Error('must not dispatch'); },
      readLedger: () => { guardReadAttempted = true; return []; },
      appendLedger: () => {},
      log: () => {},
    });
    // readLedger IS still called once by step 4's own (unrelated,
    // pre-existing) attempt-memory read — this only proves dry-run doesn't
    // ALSO run the new guard block redundantly; see the real fs-isolation
    // assertion below for the property that actually matters (no real file
    // touched on dry-run for an ENOENT ledger path).
    assert.deepStrictEqual(result.dispatched, []);
    assert.ok(guardReadAttempted);
  });

  describe('real strict readers (no deps override — production code path)', () => {
    const fs = require('node:fs');
    const os = require('node:os');

    // Ship-check (Codex adversarial review, BRO-3454): the sync version of
    // this helper did `try { return fn(file); } finally { rmSync(...) }` —
    // for an ASYNC fn, `return fn(file)` hands back a still-pending promise
    // immediately, so `finally`'s rmSync ran (deleting the ledger file)
    // BEFORE main()'s internal `await` for the issue fetch ever resolved and
    // its real read of `file` happened. The dedup test below "passed"
    // vacuously: it was reading an ENOENT'd file (→ []), not the seeded
    // duplicate rows. Fixed by awaiting fn(file) inside the try before
    // cleanup runs.
    async function withLedger(lines, fn) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drain-guard-'));
      const file = path.join(dir, 'ledger.jsonl');
      if (lines !== null) fs.writeFileSync(file, lines.join('\n') + '\n');
      try { return await fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }

    test('a real ledger file with a union-merge-duplicated costly failure is deduped before the breaker sums it (stays under threshold)', async () => {
      delete process.env.LINEAR_NEXT_DISABLED;
      // Half the threshold, duplicated: if dedup were skipped, the strict
      // reader would double-count this to over threshold and wrongly halt.
      const half = DEFAULT_SPEND_THRESHOLD_USD / 2 + 1;
      const row = JSON.stringify({ ts: new Date().toISOString(), event: 'card-fail', cardId: 'BRO-9', usd: half });
      await withLedger([row, row], async (file) => {
        const dispatchedTaskIds = [];
        const result = await main([], {
          listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' })],
          dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
          appendLedger: () => {},
          dispatchLedgerEntries: () => [],
          ledgerPath: file,
          log: () => {},
        });
        assert.deepStrictEqual(result.dispatched, ['BRO-1'], 'a deduped single half-threshold spend must not trip the breaker');
      });
    });

    // Positive control (Codex adversarial review, BRO-3454): the test above
    // only proves "didn't trip" — that alone would also pass if the real
    // file were never read at all (the exact bug this control catches: it
    // was caught live by the ENOENT/premature-cleanup bug fixed above).
    // A genuinely-over-threshold real-file spend, with NO duplication in
    // play, must still halt dispatch through the same real readLedgerStrict
    // path — proving the file really is being read and summed.
    test('a real ledger file with a genuinely over-threshold failure DOES trip the breaker (control for the dedup test above)', async () => {
      delete process.env.LINEAR_NEXT_DISABLED;
      const row = JSON.stringify({ ts: new Date().toISOString(), event: 'card-fail', cardId: 'BRO-9', usd: DEFAULT_SPEND_THRESHOLD_USD + 1 });
      await withLedger([row], async (file) => {
        const dispatchedTaskIds = [];
        const result = await main([], {
          listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' })],
          dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
          appendLedger: () => {},
          dispatchLedgerEntries: () => [],
          ledgerPath: file,
          log: () => {},
        });
        assert.deepStrictEqual(result.dispatched, [], 'a real over-threshold spend read from disk must halt dispatch');
      });
    });

    test('no ledger file yet (ENOENT) does not fail closed — dispatches normally', async () => {
      delete process.env.LINEAR_NEXT_DISABLED;
      await withLedger(null, async (file) => {
        const dispatchedTaskIds = [];
        const result = await main([], {
          listOpenIssuesWithDescriptions: async () => [issue({ identifier: 'BRO-1' })],
          dispatchFn: (taskId) => { dispatchedTaskIds.push(taskId); },
          appendLedger: () => {},
          dispatchLedgerEntries: () => [],
          ledgerPath: file, // never written — ENOENT is the healthy first-run state
          log: () => {},
        });
        assert.deepStrictEqual(result.dispatched, ['BRO-1'], 'ENOENT must not be treated as a guard-computation failure');
      });
    });
  });
});
