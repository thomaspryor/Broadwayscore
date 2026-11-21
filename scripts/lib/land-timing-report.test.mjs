// land-timing-report.js (BRO-7150): refusal causes, run outcomes and the before/after split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('./land-timing-report.js');

test('median handles odd, even and empty input', () => {
  assert.equal(R.median([3, 1, 2]), 2);
  assert.equal(R.median([4, 1, 2, 3]), 2.5);
  assert.equal(R.median([]), null);
});

test('causeFromMessage keys each refusal shape', () => {
  assert.equal(R.causeFromMessage('unit-tests-node: NEW failure on the branch (absent on origin/main): scripts/tests/global-instructions.test.mjs::CLOUD.md keeps headroom'),
    'unit-tests-node: scripts/tests/global-instructions.test.mjs');
  assert.equal(R.causeFromMessage('lint-workflows: NEW failure on the branch (absent on origin/main): lint-workflows::audit-timeouts'),
    'lint-workflows: audit-timeouts');
  assert.equal(R.causeFromMessage('lint-workflows gate failed: audit-x (exit 1)'), 'lint-workflows: audit-x');
  assert.equal(R.causeFromMessage('land/x does not rebase cleanly onto origin/main'), 'rebase conflict (Checks)');
  assert.equal(R.causeFromMessage('land/x was NOT landed — rebase: conflict'), 'rebase conflict (at landing)');
  assert.equal(R.causeFromMessage('land/x was NOT landed — protected: refused'), 'landing refused: protected');
  assert.equal(R.causeFromMessage('Process completed with exit code 1.'), null);
});

test('causesFromAnnotations falls back to the first failing gate', () => {
  const ann = [
    { annotation_level: 'failure', message: 'Process completed with exit code 1.' },
    { annotation_level: 'failure', message: 'checks RED — first failing gate: tsc' },
    { annotation_level: 'warning', message: 'tsc gate failed: ignored (warning)' },
  ];
  assert.deepEqual(R.causesFromAnnotations(ann), ['tsc (no per-test annotation)']);
});

const run = (o = {}) => ({ id: 1, head_branch: 'land/x', run_started_at: '2026-11-08T10:00:00Z', status: 'completed', conclusion: 'success', ...o });

test('summarizeRun: landed, refused and other', () => {
  const landed = R.summarizeRun(run(), [
    { name: 'Checks', conclusion: 'success', steps: [] },
    { name: 'Land', conclusion: 'success', completed_at: '2026-11-08T10:25:00Z', steps: [] },
  ]);
  assert.equal(landed.outcome, 'landed');
  assert.equal(landed.minutes, 25);
  assert.equal(landed.fast, false);

  const refused = R.summarizeRun(run({ conclusion: 'failure' }), [
    { name: 'Checks', conclusion: 'failure', completed_at: '2026-11-08T10:03:00Z', steps: [{ name: 'Fast-fail — cheap tests first', conclusion: 'failure' }] },
  ]);
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.minutes, 3);
  assert.equal(refused.fast, true);
  assert.deepEqual(refused.causes, ['fast-fail (no per-test annotation)']);

  assert.equal(R.summarizeRun(run({ conclusion: 'cancelled' }), []).outcome, 'other');
  assert.equal(R.summarizeRun(run({ status: 'in_progress' }), []).outcome, 'other');
});

test('report splits before/after by the fast-fail step or an explicit time', () => {
  const recs = [
    { outcome: 'refused', minutes: 30, causes: ['a'], fast: false, started: '2026-11-08T09:00:00Z' },
    { outcome: 'refused', minutes: 3, causes: ['a', 'b'], fast: true, started: '2026-11-08T12:00:00Z' },
    { outcome: 'landed', minutes: 20, causes: [], fast: true, started: '2026-11-08T12:30:00Z' },
  ];
  const rep = R.report(recs);
  assert.equal(rep.before.medianMinutesToRefusal, 30);
  assert.equal(rep.after.medianMinutesToRefusal, 3);
  assert.equal(rep.after.medianMinutesToLand, 20);
  assert.deepEqual(rep.all.causes[0], { cause: 'a', refusals: 2 });
  assert.equal(R.report(recs, { split: '2026-11-08T12:15:00Z' }).after.runs, 1);
});

test('parseArgs validates input', () => {
  assert.equal(R.parseArgs(['--days=3', '--json']).days, 3);
  assert.ok(R.parseArgs(['--days=0']).error);
  assert.ok(R.parseArgs(['--bogus']).error);
  assert.ok(R.parseArgs(['--split=not-a-date']).error);
});

test('percentile, refusal rate and the target check', () => {
  assert.equal(R.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(R.percentile([], 90), null);
  const recs = [
    ...Array.from({ length: 18 }, (_, i) => ({ outcome: 'landed', minutes: 20 + i, causes: [], fast: true, started: 'x' })),
    { outcome: 'refused', minutes: 3, causes: ['a'], fast: true, started: 'x' },
    { outcome: 'refused', minutes: 5, causes: ['a'], fast: true, started: 'x' },
  ];
  const agg = R.aggregate(recs);
  assert.equal(agg.refusalRate, 0.1);
  assert.deepEqual(R.checkTargets(agg), []);
  assert.match(R.checkTargets(R.aggregate(recs.slice(0, 5))).join(), /decided runs/);
  const slow = R.aggregate([...recs, ...Array.from({ length: 5 }, () => ({ outcome: 'refused', minutes: 25, causes: ['b'], fast: false, started: 'x' }))]);
  const miss = R.checkTargets(slow).join(' | ');
  assert.match(miss, /refusal rate/);
  assert.match(miss, /time-to-refusal/);
  assert.equal(R.parseArgs(['--check-targets']).check, true);
});

test('gateReport: per-gate stats per run kind, scoped and untimed rows left out (BRO-7324)', () => {
  const now = Date.parse('2026-11-21T12:00:00Z');
  const run = (wall, tsc, extra = {}) => ({ wallSecs: wall, gateSecs: { tsc, 'unit-tests-node': wall - 60 }, gates: ['tsc', 'unit-tests-node'], scoped: false, ...extra });
  const rows = [
    { ts: '2026-11-21T10:00:00Z', sha: 'a', timing: { v: 1, runs: { 'land-gauntlet/branch': run(900, 80), 'land-gauntlet/base': run(950, 90) } } },
    { ts: '2026-11-21T11:00:00Z', sha: 'b', timing: { v: 1, runs: { 'land-gauntlet/branch': run(1000, 100), 'land-gauntlet/confirm': run(200, 10, { scoped: true }) } } },
    { ts: '2026-11-21T11:30:00Z', sha: 'c', timing: { v: 1, runs: { 'land-gauntlet/branch': run(1100, 120) } } },
    { ts: '2026-11-21T11:40:00Z', sha: 'd' },
    { ts: '2026-11-01T11:00:00Z', sha: 'e', timing: { v: 1, runs: { 'land-gauntlet/branch': run(5000, 5000) } } },
  ];
  const rep = R.gateReport(rows, { days: 7, nowMs: now });
  assert.equal(rep.landings, 3);
  const b = rep.kinds['land-gauntlet/branch'];
  assert.deepEqual(b.wallSecs, { n: 3, median: 1000, min: 900, max: 1100 });
  assert.deepEqual(b.gates.tsc, { n: 3, median: 100, min: 80, max: 120 });
  assert.deepEqual(Object.keys(b.gates), ['unit-tests-node', 'tsc']);
  assert.equal(rep.kinds['land-gauntlet/confirm'].scoped, 1);
  assert.equal(rep.kinds['land-gauntlet/confirm'].wallSecs.n, 0);
  assert.equal(R.gateReport([], { nowMs: now }).landings, 0);
  assert.equal(R.parseArgs(['--gates', '--days=3']).gates, true);
  assert.ok(R.parseArgs(['--gates', '--check-targets']).error);
  // a GAUNTLET_GATES-limited run of the same kind is left out of the wall stat, kept per gate
  const lim = R.gateReport([...rows, { ts: '2026-11-21T11:50:00Z', sha: 'f', timing: { v: 1, runs: { 'land-gauntlet/branch': { wallSecs: 30, gateSecs: { tsc: 20 }, gates: ['tsc'], scoped: false } } } }], { days: 7, nowMs: now });
  assert.deepEqual(lim.kinds['land-gauntlet/branch'].wallSecs, { n: 3, median: 1000, min: 900, max: 1100 });
  assert.equal(lim.kinds['land-gauntlet/branch'].gates.tsc.n, 4);
});
