import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { findMyJob, isDispatchResolved, classifyDispatches } = require('./dispatch-reconcile.js');
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

test('the kind vocabulary is closed — adding one is a breaking change for all four callers', () => {
  // Every call site switches on `kind` and throws on an unrecognised one
  // (scripts/backlog-drain.js, scripts/lib/digest-autofix.js,
  // scripts/linear-drain-parked.js). If a new kind is introduced here, this
  // assertion fails FIRST and names the contract, instead of the new kind
  // reaching production and tripping three runtime throws on a cron.
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
  const repo = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  // dispatch-ledger.js DEFINES followRetryChain; dispatch-reconcile.js is the
  // one sanctioned consumer. Nothing else may pair them.
  const OWNERS = new Set([
    'scripts/lib/dispatch-ledger.js',
    'scripts/lib/dispatch-reconcile.js',
  ]);

  let files;
  try {
    files = execFileSync('grep', ['-rl', '--include=*.js', 'followRetryChain', 'scripts'],
      { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    files = []; // grep exits 1 when nothing matches
  }

  const offenders = files.filter((rel) => {
    if (OWNERS.has(rel)) return false;
    const src = fs.readFileSync(path.join(repo, rel), 'utf8')
      // Strip comments so a file merely DOCUMENTING the pair (as
      // backlog-drain.js and autofix-canary.js now do, pointing readers at the
      // shared implementation) is not mistaken for one reimplementing it.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(?<!:)\/\/[^\n]*/g, '');
    return /followRetryChain\s*\(/.test(src) && /JOB_EVENTS\.SPAWNED/.test(src);
  });

  assert.deepEqual(offenders, [],
    'these files pair JOB_EVENTS.SPAWNED with followRetryChain — that is findMyJob. '
    + 'Require it from scripts/lib/dispatch-reconcile.js instead of writing a fifth copy.');
});
