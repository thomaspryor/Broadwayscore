// LIVE-DATA-LANE: reads data/audit/.publish-date-triage-VEV30x/files.json (read by the test); data/audit/.publish-date-triage-VEV30x (untracked core data); data/audit/.publish-date-triage-Xqa6H5 (untracked core data); +8 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { runPublishDateBackfillTriage, scopeCrossProductionIssues } = require('../../scripts/lib/publish-date-backfill-triage');

test('refreshes evidence, applies scoped triage, then runs the blocking contamination gate', () => {
  const calls = [];
  const repoRoot = process.cwd();
  let manifest;
  runPublishDateBackfillTriage({
    repoRoot,
    touchedFiles: ['oh-mary-2024/outlet--critic.json', 'children-of-a-lesser-god-1980/outlet--critic.json', 'oh-mary-2024/outlet--critic.json'],
    run(command, args, options) {
      calls.push([path.basename(args[0]), ...args.slice(1)]);
      assert.equal(command, process.execPath);
      assert.equal(options.cwd, repoRoot);
      assert.equal(options.stdio, 'inherit');
      if (path.basename(args[0]) === 'auto-triage-cross-production.js') {
        manifest = args[2].slice('--files-from='.length);
        assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), [
          'children-of-a-lesser-god-1980/outlet--critic.json', 'oh-mary-2024/outlet--critic.json',
        ]);
      }
      return { status: 0 };
    },
  });
  assert.deepEqual(calls, [
    ['audit-cross-production.js'],
    ['auto-triage-cross-production.js', '--apply', `--files-from=${manifest}`],
    ['audit-review-contamination.js', '--gate'],
  ]);
  assert.equal(fs.existsSync(path.dirname(manifest)), false, 'temporary scope must be removed');
});

for (const failureIndex of [0, 1, 2]) {
  for (const failure of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { error: new Error('spawn failed') }]) {
    test(`fails closed at safety step ${failureIndex + 1}: ${failure.error?.message || failure.signal || failure.status}`, () => {
      let calls = 0;
      assert.throws(() => runPublishDateBackfillTriage({
        touchedFiles: new Set(['oh-mary-2024/outlet--critic.json']),
        run() { return calls++ === failureIndex ? failure : { status: 0 }; },
      }), /publishDate backfill safety check failed/);
      assert.equal(calls, failureIndex + 1, 'must stop before any later step or completion');
    });
  }
}

test('dry runs and batches with no dates written perform no triage writes or audits', () => {
  const run = () => assert.fail('unexpected subprocess');
  runPublishDateBackfillTriage({ touchedFiles: ['oh-mary-2024/outlet--critic.json'], dryRun: true, run });
  runPublishDateBackfillTriage({ touchedFiles: [], run });
});

test('scope includes newly dated files and leaves other reviews in the same show alone', () => {
  const issues = [
    { file: 'children-of-a-lesser-god-1980/outlet--critic.json', filedUnder: 'children-of-a-lesser-god-1980', closerTo: 'children-of-a-lesser-god-2018', matchReason: 'publish-date' },
    { file: 'children-of-a-lesser-god-1980/other--critic.json', filedUnder: 'children-of-a-lesser-god-1980', closerTo: 'children-of-a-lesser-god-2018', matchReason: 'publish-date' },
    { file: 'unrelated-show/outlet--critic.json', filedUnder: 'unrelated-show', closerTo: 'another-production', matchReason: 'publish-date' },
  ];
  assert.deepEqual(scopeCrossProductionIssues(issues, ['children-of-a-lesser-god-1980/outlet--critic.json']), [issues[0]]);
  assert.deepEqual(scopeCrossProductionIssues(issues, []), []);
  assert.equal(scopeCrossProductionIssues(issues, null), issues);
});

// BRO-6707: one cross-market date this batch wrote must not abort the run (it did daily from
// 2026-11-03: the same 40 files refetched, no attempt marker or confirmed date ever committed).
const { findGateBlockers, buildGateRevertedRecord } = require('../../scripts/lib/publish-date-backfill-triage');
const KRAMER = 'kramerfauci-st-anns-off-broadway-2026/one-minute-critic--matthew-wexler.json';
const auditWith = (hits) => JSON.stringify({ hits });
const leak = { A_cross_market: [{ showId: 'kramerfauci-st-anns-off-broadway-2026', file: 'one-minute-critic--matthew-wexler.json', sibId: 'kramerfauci-off-broadway-2026' }] };

function gateRun(gateResults, auditJson, log = []) {
  return (command, args) => {
    const name = path.basename(args[0]);
    log.push([name, ...args.slice(1)]);
    if (name !== 'audit-review-contamination.js') return { status: 0 };
    if (args[1] === '--json') return { status: 1, stdout: auditJson };
    return gateResults.shift();
  };
}

test('a gate failure caused by a file this batch dated reverts only that file, then re-gates', () => {
  const log = [];
  const reverted = [];
  const out = runPublishDateBackfillTriage({
    touchedFiles: [KRAMER, 'oak-regional-2025/new-city-stage--robert-eric-shoemaker.json'],
    run: gateRun([{ status: 1 }, { status: 0 }], auditWith(leak), log),
    revertBlockers: (files) => reverted.push(...files),
  });
  assert.deepEqual(reverted, [KRAMER]);
  assert.deepEqual(out, { reverted: [KRAMER] });
  assert.deepEqual(log.map((c) => c.join(' ')).slice(2), [
    'audit-review-contamination.js --gate', 'audit-review-contamination.js --json', 'audit-review-contamination.js --gate',
  ]);
});

test('the gate still fails closed when the leak is not this batch\'s, the audit is unreadable, or the re-gate fails', () => {
  const cases = [
    { touched: ['oak-regional-2025/x--y.json'], audit: auditWith(leak), gates: [{ status: 1 }] },
    { touched: [KRAMER], audit: 'not json', gates: [{ status: 1 }] },
    { touched: [KRAMER], audit: auditWith(leak), gates: [{ status: 1 }, { status: 1 }] },
    { touched: [KRAMER], audit: auditWith(leak), gates: [{ status: null, signal: 'SIGTERM' }] },
  ];
  for (const c of cases) {
    assert.throws(() => runPublishDateBackfillTriage({
      touchedFiles: c.touched, run: gateRun(c.gates, c.audit), revertBlockers: () => {},
    }), /publishDate backfill safety check failed: audit-review-contamination\.js/);
  }
  // No revert callback: the old whole-run fail-closed behaviour (backfill-network-tier-dates.js).
  assert.throws(() => runPublishDateBackfillTriage({
    touchedFiles: [KRAMER], run: gateRun([{ status: 1 }], auditWith(leak)),
  }), /safety check failed/);
});

test('findGateBlockers: strict-class hits on touched files only; report-only classes and review-level A2 ignored', () => {
  const hits = {
    ...leak,
    A2_cross_market_relative: [
      { showId: 'a', file: 'r.json', level: 'review' },
      { showId: 'a', file: 'c.json', level: 'contamination' },
    ],
    D_pre_opening_feature: [{ showId: 'a', file: 'd.json' }],
    C_domain_mismatch: [{ showId: 'a', file: 'untouched.json' }],
  };
  const touched = [KRAMER, 'a/r.json', 'a/c.json', 'a/d.json'];
  assert.deepEqual(findGateBlockers({ hits }, touched), ['a/c.json', KRAMER]);
  assert.deepEqual(findGateBlockers({ hits }, []), []);
  assert.deepEqual(findGateBlockers(null, touched), []);
});

test('buildGateRevertedRecord keeps the old date, holds the page date as a candidate and marks the file attempted', () => {
  const original = { publishDate: '2026-10-01', dateSource: 'llm-scoring', url: 'https://x' };
  const rec = buildGateRevertedRecord(original, '2026-02-15', 'html-archive-org', { now: '2026-11-09T09:17:00.000Z' });
  assert.equal(rec.publishDate, '2026-10-01');
  assert.equal(rec.dateSource, 'llm-scoring');
  assert.equal(rec.pageDateCandidate, '2026-02-15');
  assert.equal(rec.pageDateCandidateSource, 'html-archive-org');
  assert.equal(rec.needsDateRecheck, true);
  assert.equal(rec.dateRecheckAttempted, '2026-11-09T09:17:00.000Z');
  assert.equal(rec.dateRecheckAttemptReason, 'contamination-gate-blocked');
  assert.equal(original.pageDateCandidate, undefined, 'input not mutated');
  const undated = buildGateRevertedRecord({ url: 'https://x' }, '2020-01-01', 'text-regex-backfill', { recheck: false, now: 'T' });
  assert.equal(undated.publishDate, undefined);
  assert.equal(undated.dateBackfillAttempted, 'T');
  assert.equal(undated.dateRecheckAttempted, undefined);
});

test('findGateBlockers: with a class A leak in the batch, an unrelated C hit on another touched file is not reverted', () => {
  const hits = {
    ...leak,
    C_domain_mismatch: [{ showId: 'a', file: 'c-only.json' }],
  };
  assert.deepEqual(findGateBlockers({ hits }, [KRAMER, 'a/c-only.json']), [KRAMER]);
  // no A leak: strict C alone still counts
  assert.deepEqual(findGateBlockers({ hits: { C_domain_mismatch: hits.C_domain_mismatch } }, ['a/c-only.json']), ['a/c-only.json']);
});
