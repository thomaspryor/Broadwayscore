import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { findMyJob, isDispatchResolved, classifyDispatches, DECISION_KINDS } = require('./dispatch-reconcile.js');
const dispatchLedger = require('./dispatch-ledger.js');

// These tests cover the MECHANICS the three callers share (BRO-2542). Each
// caller's own outcome vocabulary and note text is tested by its own suite:
// scripts/backlog-drain.test.mjs, scripts/lib/digest-autofix.test.mjs,
// tests/unit/linear-drain-parked.test.mjs — all of which must keep passing
// unchanged, since this lib is a pure extraction of what they already did.

const E = dispatchLedger.JOB_EVENTS;
const PASS_FAIL = new Set(['card-pass', 'card-fail']);
const ORPHAN_H = 3;

// A caller shaped like digest-autofix.js's: 'auto-dispatch' rows keyed by taskId.
function classify(ledgerEntries, dispatchLedgerEntries, now, over = {}) {
  return classifyDispatches({
    ledgerEntries,
    dispatchLedgerEntries,
    isDispatchRow: e => e.event === 'auto-dispatch',
    resolvingEvents: PASS_FAIL,
    orphanTimeoutH: ORPHAN_H,
    cardIdOf: d => String(d.taskId),
    taskIdOf: d => String(d.taskId),
    now: new Date(now),
    ...over,
  });
}

// ── findMyJob ───────────────────────────────────────────────────────────────

test('findMyJob picks the EARLIEST spawn at/after the dispatch ts, never an older job', () => {
  const entries = [
    { ts: '2026-08-30T10:00:00Z', event: E.SPAWNED, taskId: '7', jobId: 'old' },
    { ts: '2026-08-30T10:05:00Z', event: E.DONE, taskId: '7', jobId: 'old' },
    { ts: '2026-08-30T11:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'mine' },
    { ts: '2026-08-30T11:40:00Z', event: E.SPAWNED, taskId: '7', jobId: 'later' },
  ];
  assert.equal(findMyJob(entries, '7', '2026-08-30T11:00:00Z').jobId, 'mine');
});

test('findMyJob allows a spawn up to 5s BEFORE the dispatch ts (clock-skew slack)', () => {
  const entries = [{ ts: '2026-08-30T10:59:57Z', event: E.SPAWNED, taskId: '7', jobId: 'skewed' }];
  assert.equal(findMyJob(entries, '7', '2026-08-30T11:00:00Z').jobId, 'skewed');
  // ...but not one that precedes it by more than the slack.
  const stale = [{ ts: '2026-08-30T10:59:50Z', event: E.SPAWNED, taskId: '7', jobId: 'stale' }];
  assert.equal(findMyJob(stale, '7', '2026-08-30T11:00:00Z'), null);
});

test('findMyJob returns null on no spawn, and tolerates a missing ledger', () => {
  assert.equal(findMyJob([], '7', '2026-08-30T11:00:00Z'), null);
  assert.equal(findMyJob(undefined, '7', '2026-08-30T11:00:00Z'), null);
});

// ── isDispatchResolved ──────────────────────────────────────────────────────

test('isDispatchResolved: an outcome BEFORE the dispatch does not resolve it, one at/after does', () => {
  const before = [{ ts: '2026-08-30T09:00:00Z', event: 'card-fail', cardId: '7' }];
  const after = [{ ts: '2026-08-30T11:00:00Z', event: 'card-fail', cardId: '7' }];
  // The BRO-2434/2506/2508 bug: a second dispatch on unchanged content must
  // still be reconcilable, or the failure streak can never reach maxFailures.
  assert.equal(isDispatchResolved(before, '7', '2026-08-30T10:00:00Z', PASS_FAIL), false);
  assert.equal(isDispatchResolved(after, '7', '2026-08-30T10:00:00Z', PASS_FAIL), true);
});

test('isDispatchResolved honors the caller-supplied event set, and compares ids as strings', () => {
  const stranded = [{ ts: '2026-08-30T11:00:00Z', event: 'card-stranded', cardId: 7 }];
  assert.equal(isDispatchResolved(stranded, '7', '2026-08-30T10:00:00Z', PASS_FAIL), false);
  const richer = new Set([...PASS_FAIL, 'card-stranded']);
  assert.equal(isDispatchResolved(stranded, '7', '2026-08-30T10:00:00Z', richer), true);
});

// ── classifyDispatches: the ts guard that drifted away on the last port ─────

test('a dispatch row with a malformed or missing ts is skipped, never scored as an immediate failure', () => {
  // NaN arithmetic makes `ageH < orphanTimeoutH` false, which without this
  // guard fires an instant orphan instead of honoring the grace window.
  const ledger = [
    { ts: 'not-a-date', event: 'auto-dispatch', taskId: '7' },
    { event: 'auto-dispatch', taskId: '8' },
  ];
  assert.deepEqual(classify(ledger, [], '2026-08-30T23:00:00Z'), []);
});

test('an invalid `now` throws instead of silently failing every dispatch at once', () => {
  // Postmortem 4 applies to the clock too: NaN makes every `ageH < timeout`
  // false, so one bad clock scores the WHOLE board failed in a single pass —
  // cards park, the spend breaker trips, and the notes read like real timeouts.
  const ledger = [{ ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' }];
  assert.throws(() => classify(ledger, [], 'not-a-date'), /must be a valid Date/);
  assert.throws(
    () => classifyDispatches({
      ledgerEntries: ledger, dispatchLedgerEntries: [],
      isDispatchRow: e => e.event === 'auto-dispatch', resolvingEvents: PASS_FAIL,
      orphanTimeoutH: ORPHAN_H, cardIdOf: d => String(d.taskId), taskIdOf: d => String(d.taskId),
      now: Date.now(), // a number, not a Date — .getTime() would not exist
    }),
    /must be a valid Date/);
});

test('a non-array dispatch ledger throws instead of orphaning every card', () => {
  // findMyJob would read a missing ledger as "no job ever spawned", so every
  // dispatch would age into a card-fail on a schedule, silently.
  const ledger = [{ ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' }];
  assert.throws(() => classify(ledger, undefined, '2026-08-30T23:00:00Z'), /must be an array/);
  assert.throws(() => classify(ledger, null, '2026-08-30T23:00:00Z'), /must be an array/);
});

test('rows of other event types are ignored, and isDispatchRow can require extra fields', () => {
  const ledger = [
    { ts: '2026-08-30T06:00:00Z', event: 'card-fail', taskId: '7' },
    { ts: '2026-08-30T06:00:00Z', event: 'auto-dispatch', taskId: '8' }, // no contentHash
  ];
  const out = classify(ledger, [], '2026-08-30T23:00:00Z');
  assert.deepEqual(out.map(d => d.cardId), ['8'], 'the card-fail row is an outcome, not a dispatch');
  // linear-drain-parked.js excludes pre-feature rows this way (no contentHash).
  const gated = classify(ledger, [], '2026-08-30T23:00:00Z', {
    isDispatchRow: e => e.event === 'auto-dispatch' && e.contentHash,
  });
  assert.deepEqual(gated, [], 'a caller-required field gates the row too');
});

// ── classifyDispatches: the two grace windows ──────────────────────────────

test('no spawn: silent inside the grace window, kind "orphan" with a null job past it', () => {
  const ledger = [{ ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' }];
  assert.deepEqual(classify(ledger, [], '2026-08-30T12:00:00Z'), [], 'may still spawn — ask again next pass');
  const late = classify(ledger, [], '2026-08-30T13:30:00Z');
  assert.equal(late.length, 1);
  assert.equal(late[0].kind, 'orphan');
  assert.equal(late[0].job, null);
  assert.equal(late[0].cardId, '7');
});

test('retry chain ending at job-retried: silent inside the window, kind "retry-timeout" past it', () => {
  const ledger = [{ ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' }];
  const dispatched = [
    { ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T10:30:00Z', event: E.RETRIED, taskId: '7', jobId: 'j1' },
  ];
  // The window runs from the RETRY's ts, not the dispatch's.
  assert.deepEqual(classify(ledger, dispatched, '2026-08-30T13:00:00Z'), []);
  const late = classify(ledger, dispatched, '2026-08-30T14:00:00Z');
  assert.equal(late.length, 1);
  assert.equal(late[0].kind, 'retry-timeout');
  assert.equal(late[0].job.jobId, 'j1');
});

test('a job with no terminal event yet is still running — no decision, however old', () => {
  const ledger = [{ ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' }];
  const dispatched = [{ ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' }];
  assert.deepEqual(classify(ledger, dispatched, '2026-08-31T10:00:00Z'), []);
});

test('a terminal job yields kind "terminal" and hands the job back for the caller to classify', () => {
  const ledger = [{ ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' }];
  const dispatched = [
    { ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T10:20:00Z', event: E.DONE, taskId: '7', jobId: 'j1', costUSD: 2 },
  ];
  const out = classify(ledger, dispatched, '2026-08-30T11:00:00Z');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'terminal');
  assert.equal(out[0].job.event, E.DONE);
  assert.equal(out[0].job.costUSD, 2, 'the folded job is passed through, so cost accounting stays possible');
  assert.equal(out[0].dispatch, ledger[0], 'the caller gets its own row back, not a copy');
});

// ── classifyDispatches: the claimedJobIds race guard ────────────────────────

test('two dispatch rows racing onto the SAME job produce ONE decision, not two', () => {
  const ledger = [
    { ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' },
    { ts: '2026-08-30T10:00:02Z', event: 'auto-dispatch', taskId: '7' },
  ];
  const dispatched = [
    { ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T10:20:00Z', event: E.DONE, taskId: '7', jobId: 'j1' },
  ];
  const out = classify(ledger, dispatched, '2026-08-30T11:00:00Z');
  assert.equal(out.length, 1, 'only one job actually spawned, so only one outcome is earned');
});

test('two dispatch rows mapping to DIFFERENT jobs each resolve independently (BRO-2508)', () => {
  const ledger = [
    { ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' },
    { ts: '2026-08-30T12:00:00Z', event: 'auto-dispatch', taskId: '7' },
  ];
  const dispatched = [
    { ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T10:20:00Z', event: E.FAILED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T12:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j2' },
    { ts: '2026-08-30T12:20:00Z', event: E.DONE, taskId: '7', jobId: 'j2' },
  ];
  const out = classify(ledger, dispatched, '2026-08-30T13:00:00Z');
  assert.equal(out.length, 2, 'a second, genuinely separate attempt must score separately');
  assert.deepEqual(out.map(d => d.job.jobId), ['j1', 'j2']);
});

test('an orphan and a terminal outcome coexist in one pass — the orphan suppresses nothing', () => {
  // The orphan branch has no jobId by definition, so it claims nothing; a
  // different card that DID spawn still earns its own outcome the same pass.
  const ledger = [
    { ts: '2026-08-30T06:00:00Z', event: 'auto-dispatch', taskId: '8' }, // never spawned
    { ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' },
  ];
  const dispatched = [
    { ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T10:20:00Z', event: E.DONE, taskId: '7', jobId: 'j1' },
  ];
  const out = classify(ledger, dispatched, '2026-08-30T11:00:00Z');
  assert.deepEqual(out.map(d => [d.cardId, d.kind]), [['8', 'orphan'], ['7', 'terminal']]);
});

test('an EARLIER dispatch row that correlates onto the same job claims it, suppressing the later row', () => {
  // Rows are walked in ledger order, so the first row to reach a job owns it.
  // This is the duplicate-dispatch race the jobId guard exists for: only one
  // job ever spawned, so only one outcome is earned — by the row that caused it.
  const ledger = [
    { ts: '2026-08-30T09:59:00Z', event: 'auto-dispatch', taskId: '7' },
    { ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' },
  ];
  const dispatched = [
    { ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T10:20:00Z', event: E.DONE, taskId: '7', jobId: 'j1' },
  ];
  const out = classify(ledger, dispatched, '2026-08-30T11:00:00Z');
  assert.equal(out.length, 1);
  assert.equal(out[0].dispatch.ts, '2026-08-30T09:59:00Z');
});

test('BRO-2514: one spawn, two close dispatch rows, reconciled 3h+ later → ONE terminal outcome, no spurious orphan', () => {
  const ledger = [
    { ts: '2026-08-30T09:59:00Z', event: 'auto-dispatch', taskId: '7' },
    { ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' },
  ];
  const dispatched = [
    { ts: '2026-08-30T10:00:01Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T10:20:00Z', event: E.DONE, taskId: '7', jobId: 'j1' },
  ];
  const out = classify(ledger, dispatched, '2026-08-30T15:00:00Z');
  assert.deepEqual(out.map(d => [d.kind, d.job && d.job.jobId]), [['terminal', 'j1']]);
});

// ── classifyDispatches: resolution is read from the pre-pass ledger only ────

test('an already-resolved dispatch is skipped, but a LATER dispatch of the same card is not', () => {
  const ledger = [
    { ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' },
    { ts: '2026-08-30T10:30:00Z', event: 'card-fail', cardId: '7' },
    { ts: '2026-08-30T12:00:00Z', event: 'auto-dispatch', taskId: '7' },
  ];
  const dispatched = [
    { ts: '2026-08-30T12:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j2' },
    { ts: '2026-08-30T12:20:00Z', event: E.DONE, taskId: '7', jobId: 'j2' },
  ];
  const out = classify(ledger, dispatched, '2026-08-30T13:00:00Z');
  assert.equal(out.length, 1);
  assert.equal(out[0].dispatch.ts, '2026-08-30T12:00:00Z');
});

test('classifying leaves the caller\'s ledger array untouched', () => {
  // All three callers hand their LIVE pre-pass ledger straight in, and
  // postmortem 2 depends on it staying immutable for the whole pass. Cheap to
  // assert, and it catches in-place normalisation/annotation of rows — which
  // the suppression tests would not, since such a mutation need not change
  // any decision for a given fixture (code-review finding).
  const ledger = [
    { ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' },
    { ts: '2026-08-30T06:00:00Z', event: 'auto-dispatch', taskId: '8' },
  ];
  // Deliberately OUT of ts order, with TWO spawns (code-review finding): an
  // already-sorted single-spawn fixture makes an in-place sort a no-op, so the
  // assertion below could not fail for the hazard it names.
  const dispatched = [
    { ts: '2026-08-30T10:20:00Z', event: E.DONE, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T09:00:00Z', event: E.SPAWNED, taskId: '9', jobId: 'j0' },
  ];
  // BOTH arrays (code-review finding): the in-place hazard actually lives in
  // findMyJob's `.filter().sort()` over dispatchLedgerEntries — drop the
  // .filter() and .sort() reorders the CALLER's live shared ledger in place.
  const ledgerSnapshot = structuredClone(ledger);
  const dispatchedSnapshot = structuredClone(dispatched);
  const out = classify(ledger, dispatched, '2026-08-30T23:00:00Z');
  assert.ok(out.length > 0, 'fixture must actually produce decisions, or this asserts nothing');
  assert.deepEqual(ledger, ledgerSnapshot);
  assert.deepEqual(dispatched, dispatchedSnapshot, 'the SHARED dispatch ledger must not be reordered in place');
});

test('resolution reads ONLY the pre-pass ledger — one row resolving cannot resolve its siblings', () => {
  // Postmortem 2, the load-bearing version: an earlier draft cross-checked
  // against breadcrumbs emitted during the SAME pass, tagged `now`. Since
  // `now` is later than every historical dispatch ts by construction,
  // resolving one stale dispatch would instantly satisfy `>= dispatchTs` for
  // every other unresolved dispatch of that card — collapsing genuinely
  // separate sequential re-attempts onto one outcome, which is precisely the
  // failure-streak counting BRO-2434 needs. Three separate attempts, three
  // distinct jobs: all three must score.
  const ledger = [
    { ts: '2026-08-30T06:00:00Z', event: 'auto-dispatch', taskId: '7' },
    { ts: '2026-08-30T08:00:00Z', event: 'auto-dispatch', taskId: '7' },
    { ts: '2026-08-30T10:00:00Z', event: 'auto-dispatch', taskId: '7' },
  ];
  const dispatched = [
    { ts: '2026-08-30T06:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T06:30:00Z', event: E.FAILED, taskId: '7', jobId: 'j1' },
    { ts: '2026-08-30T08:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j2' },
    { ts: '2026-08-30T08:30:00Z', event: E.FAILED, taskId: '7', jobId: 'j2' },
    { ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: '7', jobId: 'j3' },
    { ts: '2026-08-30T10:30:00Z', event: E.FAILED, taskId: '7', jobId: 'j3' },
  ];
  const out = classify(ledger, dispatched, '2026-08-30T11:00:00Z');
  assert.deepEqual(out.map(d => d.job.jobId), ['j1', 'j2', 'j3'],
    'each attempt must earn its own outcome, or the card can never reach its park threshold');
});

test('the kind vocabulary is EXACTLY these three — adding one is a breaking change for every caller', () => {
  // Introspective on purpose (code-review finding). An earlier version only
  // inspected the kinds four fixtures happened to produce, so adding a fourth
  // kind that no fixture triggered would sail through here and then trip the
  // three runtime throws on a cron — the precise outcome this is meant to
  // prevent. Asserting the frozen export itself is what makes it a contract:
  // a new kind cannot be added without editing this line, which is the prompt
  // to go handle it at every call site.
  assert.deepEqual(Object.entries(DECISION_KINDS).sort((a, b) => a[0].localeCompare(b[0])), [
    ['ORPHAN', 'orphan'],
    ['RETRY_TIMEOUT', 'retry-timeout'],
    ['TERMINAL', 'terminal'],
  ]);
  assert.ok(Object.isFrozen(DECISION_KINDS), 'DECISION_KINDS must be frozen — callers branch on it');
});

test('every decision carries one of the three kinds, and a still-running job yields none', () => {
  const ledger = [
    { ts: '2026-08-30T06:00:00Z', event: 'auto-dispatch', taskId: 'orphaned' },
    { ts: '2026-08-30T06:00:00Z', event: 'auto-dispatch', taskId: 'retried' },
    { ts: '2026-08-30T06:00:00Z', event: 'auto-dispatch', taskId: 'finished' },
    { ts: '2026-08-30T06:00:00Z', event: 'auto-dispatch', taskId: 'running' },
  ];
  const dispatched = [
    { ts: '2026-08-30T06:00:05Z', event: E.SPAWNED, taskId: 'retried', jobId: 'r1' },
    { ts: '2026-08-30T06:10:00Z', event: E.RETRIED, taskId: 'retried', jobId: 'r1' },
    { ts: '2026-08-30T06:00:05Z', event: E.SPAWNED, taskId: 'finished', jobId: 'f1' },
    { ts: '2026-08-30T06:10:00Z', event: E.DONE, taskId: 'finished', jobId: 'f1' },
    { ts: '2026-08-30T06:00:05Z', event: E.SPAWNED, taskId: 'running', jobId: 'x1' },
  ];
  const out = classify(ledger, dispatched, '2026-08-30T12:00:00Z');
  assert.deepEqual(out.map(d => `${d.cardId}:${d.kind}`),
    ['orphaned:orphan', 'retried:retry-timeout', 'finished:terminal'],
    'a still-running job yields no decision; every other row maps to exactly one of the three kinds');
  assert.deepEqual([...new Set(out.map(d => d.kind))].sort(),
    ['orphan', 'retry-timeout', 'terminal']);
});

test('taskIdOf may namespace the shared-ledger key independently of cardIdOf', () => {
  // linear-drain-parked.js keys its own ledger on the bare identifier but
  // correlates against the shared ledger's `linear:<identifier>` taskId.
  const ledger = [{ ts: '2026-08-30T10:00:00Z', event: 'drain-parked-dispatch', identifier: 'BRO-1', contentHash: 'h' }];
  const dispatched = [
    { ts: '2026-08-30T10:00:05Z', event: E.SPAWNED, taskId: 'linear:BRO-1', jobId: 'j1' },
    { ts: '2026-08-30T10:20:00Z', event: E.DONE, taskId: 'linear:BRO-1', jobId: 'j1' },
  ];
  const out = classifyDispatches({
    ledgerEntries: ledger,
    dispatchLedgerEntries: dispatched,
    isDispatchRow: e => e.event === 'drain-parked-dispatch' && e.identifier && e.contentHash,
    resolvingEvents: PASS_FAIL,
    orphanTimeoutH: ORPHAN_H,
    cardIdOf: d => d.identifier,
    taskIdOf: d => `linear:${d.identifier}`,
    now: new Date('2026-08-30T11:00:00Z'),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].cardId, 'BRO-1', 'the emitted key is the bare identifier attempt-memory expects');
  assert.equal(out[0].kind, 'terminal');
});

// ── class guard: no FIFTH copy of the spawn-correlation logic ───────────────

test('no file reimplements the spawn->job correlation outside this lib (BRO-2542 class guard)', () => {
  // The premise of BRO-2542 is that this logic gets COPIED and then drifts:
  // three drains each grew their own byte-identical copy, the third silently
  // dropped a guard the first two had, and a FOURTH copy
  // (autofix-canary.js's findCanarySpawn) survived the first pass of the
  // extraction itself — found only because a reviewer happened to grep for it.
  // Consolidating without a guard just resets the clock on the same drift.
  //
  // The signature of a reimplementation is referencing BOTH the spawn event
  // and the retry-chain follower: that pair is findMyJob's whole body, and
  // every one of the four copies matched it. Callers should require
  // dispatch-reconcile.js's findMyJob instead.
  // fileURLToPath, not new URL(...).pathname: the latter is percent-encoded, so
  // a checkout under a path with a space resolves to a directory that does not
  // exist and the readFileSync below throws ENOENT (code-review finding).
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  // dispatch-ledger.js DEFINES followRetryChain; dispatch-reconcile.js is the
  // one sanctioned consumer. Nothing else may pair them. The two test files
  // legitimately name both while testing them.
  // Deliberately NOT exempting this test file: it names neither pattern in a
  // matching form, so leaving it policed costs nothing and halves the hole an
  // allowlist opens (a real fifth copy could otherwise hide in an exempt
  // file). dispatch-ledger.test.mjs's exemption IS load-bearing — it genuinely
  // exercises followRetryChain( against JOB_EVENTS.SPAWNED fixtures.
  const OWNERS = new Set([
    'scripts/lib/dispatch-ledger.js',
    'scripts/lib/dispatch-reconcile.js',
    'scripts/lib/dispatch-ledger.test.mjs',
  ]);

  // .mjs and .cjs too, not just .js (code-review finding — demonstrated: a
  // fifth copy written as scripts/__tmp_fifth.mjs passed this guard green
  // while the identical .js file failed it, and there are 40+ non-test .mjs
  // modules under scripts/ today).
  let files;
  try {
    files = execFileSync('grep',
      ['-rl', '--include=*.js', '--include=*.mjs', '--include=*.cjs', 'followRetryChain', 'scripts'],
      { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (err) {
    // grep exits 1 for "no matches" and 2 for real errors (missing binary,
    // unsupported --include, unreadable path). Swallowing 2 as "nothing
    // matched" would silently disable this guard while it reports green.
    if (err.status !== 1) throw err;
    files = [];
  }
  // Positive control: if the grep silently matches nothing, the offender list
  // is trivially empty and the assertion below passes while checking NOTHING.
  assert.ok(files.includes('scripts/lib/dispatch-reconcile.js'),
    `grep found no followRetryChain in the lib itself — the scan is broken, not clean (got: ${files.join(', ') || 'nothing'})`);

  // Tracked OR untracked-but-not-ignored (code-review finding). Scoping to
  // `git ls-files` alone disabled the guard at exactly the moment it exists to
  // fire: a freshly written fifth copy passes green until someone stages it.
  // --others --exclude-standard keeps the original fix (a gitignored scratch
  // file must not fail the suite) without that hole.
  // -c core.quotePath=false: quotePath is ON by default and emits
  // "scripts/lib/caf\303\251.js" for a non-ASCII name while grep emits raw
  // bytes, which would silently exempt that file.
  const visible = new Set(
    execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard', 'scripts'],
      { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean));
  // Same positive control the grep gets, and for the same reason: if this set
  // ever stops lining up with grep's path format, every candidate is filtered
  // out and the assertion below passes while checking nothing.
  assert.ok(visible.has('scripts/lib/dispatch-reconcile.js'),
    'git ls-files output does not line up with grep paths — the filter is broken, not clean');

  // Comment handling, per line so a block-stripping regex can never swallow
  // real code to the next `*/` (every such failure is a FALSE NEGATIVE — a
  // genuine fifth copy hides). Two rules, because dropping whole lines alone
  // reintroduced a FALSE-POSITIVE class: a trailing `// ... followRetryChain(
  // ... JOB_EVENTS.SPAWNED` on a code line flagged a documenting file as a
  // fifth copy (code-review finding).
  //   1. strip a trailing line comment — (?<!:) so a `https://` URL survives;
  //   2. drop a whole line only when it is a doc-comment body (`* text`) or
  //      opens a block comment. `\*\s` not `\*`, so a generator declaration
  //      (`*someGen() {`) is code, not commentary.
  const stripComment = (line) => line.replace(/(?<!:)\/\/.*$/, '');
  const isCommentary = (line) => /^\s*(\*\s|\/\*)/.test(line);

  // Needles built by concatenation so this file does not match its OWN
  // detector. That matters because dispatch-reconcile.test.mjs is deliberately
  // NOT in OWNERS — it polices itself like any other file — and the previous
  // spelling escaped only by accident (the source read `\s*\(` and `\.`, not
  // `(` and `.`), which would break the moment anyone simplified the regex.
  const NEEDLE_FOLLOW = 'followRetryChain' + '(';
  const NEEDLE_SPAWNED = 'JOB_EVENTS' + '.SPAWNED';
  const offenders = files.filter((rel) => {
    if (OWNERS.has(rel) || !visible.has(rel)) return false;
    const code = fs.readFileSync(path.join(repo, rel), 'utf8')
      .split('\n').filter((l) => !isCommentary(l)).map(stripComment).join('\n');
    return code.includes(NEEDLE_FOLLOW) && code.includes(NEEDLE_SPAWNED);
  });

  assert.deepEqual(offenders, [],
    'these files pair JOB_EVENTS.SPAWNED with followRetryChain — that is findMyJob. '
    + 'Require it from scripts/lib/dispatch-reconcile.js instead of writing a fifth copy.');
});

// ── BRO-3321: outcomeWindowTs + the hoisted ORPHAN_TIMEOUT_H ────────────────

test('outcomeWindowTs prefers the judged dispatch ts, falls back to write ts', () => {
  const { outcomeWindowTs } = require('./dispatch-reconcile.js');
  assert.equal(
    outcomeWindowTs({ ts: '2026-09-14T11:37:13Z', judgedDispatchTs: '2026-08-14T11:30:46Z' }),
    '2026-08-14T11:30:46Z',
    'an outcome is ABOUT the dispatch it judges, not the moment we wrote it down'
  );
  // Rows written before the field existed must still be usable, not dropped.
  assert.equal(outcomeWindowTs({ ts: '2026-09-14T11:37:13Z' }), '2026-09-14T11:37:13Z');
  assert.equal(outcomeWindowTs(null), undefined);
  assert.equal(outcomeWindowTs(undefined), undefined);
  assert.equal(outcomeWindowTs({}), undefined);
});

test('ORPHAN_TIMEOUT_H is exported here and is the value all reconcilers use', () => {
  // Hoisted because four modules declared their own `= 3` while all four then
  // handed it back to classifyDispatches as `orphanTimeoutH`.
  const { ORPHAN_TIMEOUT_H } = require('./dispatch-reconcile.js');
  assert.equal(typeof ORPHAN_TIMEOUT_H, 'number');
  assert.ok(ORPHAN_TIMEOUT_H > 0);
  assert.equal(ORPHAN_TIMEOUT_H, 3, 'changing this changes orphan detection for every drain at once — deliberate');
});

// ── BRO-2989: orphaned in-flight Linear work is detected and re-owned ───────
// The acceptance contract for the card: a started issue whose owning session
// is dead IS re-dispatched; one whose owner is alive is NOT touched. A
// one-way test would pass on a bug that re-dispatches everything.
const { classifyOrphanedInFlight, KINDS: ORPHAN_KINDS, handledKey, buildReownComment, REOWN_MARKER } = require('./linear-orphaned-inflight.js');
const { classifyZombieComment } = require('./linear-started-zombie-sweep-verify.js');

const NOW = Date.parse('2026-10-20T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const H = 3600e3;
const tid = (id) => `linear:${id}`;
function issue(identifier, over = {}) {
  return {
    identifier, title: `P1: thing ${identifier}`, priority: 2,
    description: '## Acceptance criteria\n\n`node --test scripts/lib/dispatch-reconcile.test.mjs`\n',
    state: { type: 'started', name: 'In Progress' }, comments: { nodes: [] }, ...over,
  };
}
const spawned = (id, jobId, msAgo) => ({ event: E.SPAWNED, taskId: tid(id), jobId, ts: iso(msAgo) });
const orphanedRow = (id, jobId, msAgo) => ({ event: E.ORPHANED, taskId: tid(id), jobId, ts: iso(msAgo) });
const run = (issues, ledgerEntries, over = {}) => classifyOrphanedInFlight({ issues, ledgerEntries, nowMs: NOW, ...over });

test('BRO-2989: a started issue whose session is dead is detected and re-dispatched', () => {
  const ledger = [spawned('BRO-1', 'j1', 5 * H), orphanedRow('BRO-1', 'j1', 4 * H)];
  const { decisions } = run([issue('BRO-1')], ledger);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, ORPHAN_KINDS.REDISPATCH);
  assert.equal(decisions[0].identifier, 'BRO-1');
});

test('BRO-2989: a started issue whose owner is ALIVE is not touched', () => {
  const alive = [spawned('BRO-2', 'j2', 1 * H)];
  assert.deepEqual(run([issue('BRO-2')], alive).decisions, []);
  assert.equal(run([issue('BRO-2')], alive).skipped[0].reason, 'owner-alive');
  // An older death superseded by a live re-dispatch must not fire either.
  const redispatched = [spawned('BRO-3', 'a', 9 * H), orphanedRow('BRO-3', 'a', 8 * H), spawned('BRO-3', 'b', 1 * H)];
  assert.deepEqual(run([issue('BRO-3')], redispatched).decisions, []);
  // The caller's own liveness knowledge (lease/process) also protects it.
  const dead = [spawned('BRO-4', 'j4', 5 * H), orphanedRow('BRO-4', 'j4', 4 * H)];
  assert.deepEqual(run([issue('BRO-4')], dead, { liveTaskIds: new Set([tid('BRO-4')]) }).decisions, []);
});

test('BRO-2989: dead and alive in one pass — only the dead one is acted on', () => {
  const ledger = [spawned('BRO-5', 'j5', 5 * H), orphanedRow('BRO-5', 'j5', 4 * H), spawned('BRO-6', 'j6', 1 * H)];
  const { decisions } = run([issue('BRO-5'), issue('BRO-6')], ledger);
  assert.deepEqual(decisions.map((d) => d.identifier), ['BRO-5']);
});

test('BRO-2989: dead-shaped rows that do NOT mean a dead owner are left alone', () => {
  const cases = {
    abandoned: [{ event: E.ABANDONED, taskId: tid('BRO-7'), jobId: 'x', ts: iso(4 * H) }],   // another job holds the card
    stranded: [spawned('BRO-7', 'x', 5 * H), { event: E.STRANDED, taskId: tid('BRO-7'), jobId: 'x', ts: iso(4 * H) }], // real commits exist
    done: [spawned('BRO-7', 'x', 5 * H), { event: E.DONE, taskId: tid('BRO-7'), jobId: 'x', ts: iso(4 * H) }],         // zombie sweep's job
    suspect: [spawned('BRO-7', 'x', 5 * H), { event: E.ORPHAN_SUSPECT, taskId: tid('BRO-7'), jobId: 'x', ts: iso(4 * H) }], // one liveness glance
    none: [],
  };
  for (const [name, ledger] of Object.entries(cases)) {
    assert.deepEqual(run([issue('BRO-7')], ledger).decisions, [], name);
  }
  const vanished = [spawned('BRO-8', 'y', 5 * H), orphanedRow('BRO-8', 'y', 4 * H), { event: 'vanished', taskId: tid('BRO-8'), ts: iso(3 * H) }];
  assert.deepEqual(run([issue('BRO-8')], vanished).decisions, [], 'parked/vanished workspace');
});

test('BRO-2989: an owner/crown card with a dead session is surfaced, never auto-redispatched', () => {
  const ledger = [spawned('BRO-9', 'j9', 5 * H), orphanedRow('BRO-9', 'j9', 4 * H)];
  const { decisions } = run([issue('BRO-9', { title: '❓ 👑 OWNER — Crown v33: P1 backlog dispatch' })], ledger);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, ORPHAN_KINDS.NOTIFY_OWNER);
  assert.equal(decisions[0].reason, 'owner-card-session-died');
});

test('BRO-2989: cards the watchdog would refuse, or out of attempts, are surfaced not moved', () => {
  const ledger = [spawned('BRO-10', 'j', 5 * H), orphanedRow('BRO-10', 'j', 4 * H)];
  const unarmed = run([issue('BRO-10', { description: 'no acceptance command' })], ledger).decisions[0];
  assert.equal(unarmed.kind, ORPHAN_KINDS.NOTIFY_OWNER);
  assert.match(unarmed.reason, /^watchdog-would-refuse:/);
  const many = [];
  for (let i = 0; i < 2; i++) many.push(spawned('BRO-11', `k${i}`, (20 - i * 4) * H), orphanedRow('BRO-11', `k${i}`, (19 - i * 4) * H));
  const exhausted = run([issue('BRO-11')], many).decisions[0];
  assert.equal(exhausted.kind, ORPHAN_KINDS.NOTIFY_OWNER);
  assert.match(exhausted.reason, /^attempts-exhausted/);
});

test('BRO-2989: grace window, human comment, report, in-review and opt-out all hold the card', () => {
  const fresh = [spawned('BRO-12', 'j', 1 * H), orphanedRow('BRO-12', 'j', 5 * 60e3)];
  assert.equal(run([issue('BRO-12')], fresh).skipped[0].reason, 'within-grace');
  const dead = [spawned('BRO-13', 'j', 5 * H), orphanedRow('BRO-13', 'j', 4 * H)];
  const comment = (body) => ({ comments: { nodes: [{ body, createdAt: iso(1 * H) }] } });
  assert.equal(run([issue('BRO-13', comment('can you look at the footer?'))], dead).skipped[0].reason, 'human-on-thread');
  assert.equal(run([issue('BRO-13', comment('**Session report (blocked)** stuck'))], dead).skipped[0].reason, 'already-reported');
  assert.equal(run([issue('BRO-13', { state: { type: 'started', name: 'In Review' } })], dead).skipped[0].reason, 'in-review');
  assert.equal(run([issue('BRO-13', { description: 'NO-RECLAIM: tracker' })], dead).skipped[0].reason, 'opted-out');
});

test('BRO-2989: one action per dead attempt, and a tick cap on moves', () => {
  const ledger = [spawned('BRO-14', 'j', 5 * H), orphanedRow('BRO-14', 'j', 4 * H)];
  const handled = new Set([handledKey(tid('BRO-14'), iso(4 * H))]);
  assert.equal(run([issue('BRO-14')], ledger, { handled }).skipped[0].reason, 'already-handled');
  const ids = ['BRO-20', 'BRO-21', 'BRO-22'];
  const many = ids.flatMap((id) => [spawned(id, id, 5 * H), orphanedRow(id, id, 4 * H)]);
  const capped = run(ids.map((id) => issue(id)), many, { maxPerTick: 2 });
  assert.equal(capped.decisions.length, 2);
  assert.ok(capped.skipped.some((s) => s.reason === 'tick-cap'));
});

test('BRO-2989: the sweep\'s own comment reads as a machine comment, not a human', () => {
  const body = buildReownComment({ identifier: 'BRO-1', deadEvent: E.ORPHANED, deadTs: iso(H), kind: ORPHAN_KINDS.REDISPATCH });
  assert.ok(body.includes(REOWN_MARKER));
  assert.equal(classifyZombieComment(body), 'own-reset');
});

test('BRO-2989: bad inputs throw instead of silently re-owning the board', () => {
  assert.throws(() => classifyOrphanedInFlight({ issues: [], ledgerEntries: [], nowMs: NaN }), TypeError);
  assert.throws(() => classifyOrphanedInFlight({ issues: [], ledgerEntries: null, nowMs: NOW }), TypeError);
});

test('BRO-2989: an unverified launch is a death only when a paired dead row exists (slow-boot launches are live)', () => {
  const launch = { event: 'launch', taskId: tid('BRO-30'), workspaceRef: 'workspace:9', unverified: true, ts: iso(4 * H) };
  assert.deepEqual(run([issue('BRO-30')], [launch]).decisions, [], 'bare unverified launch = booting session');
  const paired = [{ event: 'dead', taskId: tid('BRO-30'), workspaceRef: 'workspace:9', ts: iso(4 * H) }, launch];
  assert.equal(run([issue('BRO-30')], paired).decisions[0].kind, ORPHAN_KINDS.REDISPATCH);
});

test('BRO-2989: a timed-out job the resume path can still pick up is not re-owned', () => {
  const ledger = [spawned('BRO-31', 'j', 5 * H), { event: E.FAILED, stage: 'timeout', taskId: tid('BRO-31'), jobId: 'j', ts: iso(4 * H) }];
  assert.equal(run([issue('BRO-31')], ledger).skipped[0].reason, 'timeout-resumable');
});

test('BRO-2989: candidate selection is newest-death-first and drops unsettled deaths, so old dead cards cannot starve new ones', () => {
  const { selectOrphanCandidates } = require('./linear-orphaned-inflight.js');
  const ledger = [];
  for (let i = 0; i < 30; i++) { // 30 old stopped-short cards the classifier will always skip
    ledger.push(spawned(`BRO-${100 + i}`, `o${i}`, (900 - i) * H), { event: E.STOPPED_SHORT, taskId: tid(`BRO-${100 + i}`), jobId: `o${i}`, ts: iso((899 - i) * H) });
  }
  ledger.push(spawned('BRO-500', 'n', 3 * H), orphanedRow('BRO-500', 'n', 2 * H));
  const picked = selectOrphanCandidates(ledger, { limit: 5 });
  assert.deepEqual(picked.map((c) => c.identifier), ['BRO-500']);
  const handled = new Set([handledKey(tid('BRO-500'), iso(2 * H))]);
  assert.deepEqual(selectOrphanCandidates(ledger, { handled }), []);
});

// The sweep wrapper itself (I/O seams injected).
test('BRO-2989: sweepOrphanedLinearInFlight moves dead cards, never live ones, persists handled, and is hourly', async () => {
  const fs2 = await import('node:fs');
  const os2 = await import('node:os');
  const { sweepOrphanedLinearInFlight } = require('../bsc-reconcile.js');
  const statePath = path.join(fs2.mkdtempSync(path.join(os2.tmpdir(), 'orph-')), 'state.json');
  const ledger = [
    spawned('BRO-40', 'a', 5 * H), orphanedRow('BRO-40', 'a', 4 * H),      // dead
    spawned('BRO-41', 'b', 1 * H),                                         // alive
    spawned('BRO-42', 'c', 5 * H), orphanedRow('BRO-42', 'c', 4 * H),      // dead owner card
  ];
  const issues = { 'BRO-40': issue('BRO-40'), 'BRO-41': issue('BRO-41'), 'BRO-42': issue('BRO-42', { title: '👑 OWNER — Crown v9' }) };
  const applied = []; const reports = []; let fail = true;
  const deps = {
    readLedgerEntriesFn: () => ledger, getIssueFn: async (id) => issues[id],
    applyFn: (a) => { applied.push(a.identifier); return fail ? { ok: false, status: 1, stderr: 'boom' } : { ok: true }; },
    reportFn: (r) => reports.push(r), hasLiveLeaseFn: () => false, nowFn: () => NOW, statePath,
  };
  const r1 = await sweepOrphanedLinearInFlight({ deps });
  assert.deepEqual(applied, ['BRO-40']);                       // alive BRO-41 and owner card BRO-42 never moved
  assert.ok(reports.some((x) => x.kind === 'linear-orphaned-owner-alert' && x.identifier === 'BRO-42'));
  assert.ok(reports.some((x) => x.kind === 'linear-orphaned-reown-failed'));
  assert.equal(r1.notified.length, 1);
  // Inside the hour: gated. After it: failed move retried, owner alert NOT repeated.
  assert.equal((await sweepOrphanedLinearInFlight({ deps })).ran, false);
  fail = false; reports.length = 0;
  const r2 = await sweepOrphanedLinearInFlight({ deps: { ...deps, nowFn: () => NOW + 2 * H } });
  assert.deepEqual(applied, ['BRO-40', 'BRO-40']);
  assert.equal(reports.filter((x) => x.kind === 'linear-orphaned-owner-alert').length, 0);
  assert.equal(r2.redispatched.length, 1);
});
