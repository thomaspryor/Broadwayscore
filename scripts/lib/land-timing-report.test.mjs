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

test('summarizeRun (BRO-7324): "Checks (shard 2/2)" is never Checks, never a refusal, and its time is reported apart', () => {
  const B = (o) => ({ name: 'Checks (shard 2/2)', started_at: '2026-11-08T10:01:00Z', completed_at: '2026-11-08T10:13:00Z', steps: [{ name: 'Fast-fail — cheap tests first', conclusion: 'failure' }], ...o });
  // B failed or was cancelled, Land succeeded: the run is red/cancelled, the change landed.
  for (const conclusion of ['failure', 'cancelled']) {
    const r = R.summarizeRun(run({ conclusion }), [
      B({ conclusion: conclusion === 'failure' ? 'failure' : 'cancelled' }),
      { name: 'Checks', conclusion: 'success', steps: [] },
      { name: 'Land', conclusion: 'success', completed_at: '2026-11-08T10:20:00Z', steps: [] },
    ]);
    assert.equal(r.outcome, 'landed', conclusion);
    assert.equal(r.minutes, 20);
    assert.equal(r.fast, false, 'B listed first is not read as Checks');
    assert.deepEqual(r.shard, { conclusion: conclusion === 'failure' ? 'failure' : 'cancelled', minutes: 12 });
  }
  // A real refusal still names Checks, not B.
  const refused = R.summarizeRun(run({ conclusion: 'failure' }), [
    B({ conclusion: 'failure' }),
    { name: 'Checks', conclusion: 'failure', completed_at: '2026-11-08T10:09:00Z', steps: [{ name: 'Gate verdict', conclusion: 'failure' }] },
  ]);
  assert.equal(refused.refusedIn, 'Checks');
  assert.deepEqual(refused.causes, ['Checks: step "Gate verdict"']);
  // B alone failing with no Land job is not a refusal.
  assert.equal(R.summarizeRun(run({ conclusion: 'failure' }), [B({ conclusion: 'failure' }), { name: 'Checks', conclusion: 'success', steps: [] }]).outcome, 'other');
  assert.equal(R.summarizeRun(run(), [{ name: 'Checks', conclusion: 'success', steps: [] }]).shard, null);
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
  const run = (wall, tsc, extra = {}) => ({ wallSecs: wall, gateSecs: { tsc, 'unit-tests-node': wall - 60 }, gateCount: 2, scoped: false, ...extra });
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
  const lim = R.gateReport([...rows, { ts: '2026-11-21T11:50:00Z', sha: 'f', timing: { v: 1, runs: { 'land-gauntlet/branch': { wallSecs: 30, gateSecs: { tsc: 20 }, gateCount: 1, scoped: false } } } }], { days: 7, nowMs: now });
  assert.deepEqual(lim.kinds['land-gauntlet/branch'].wallSecs, { n: 3, median: 1000, min: 900, max: 1100 });
  assert.equal(lim.kinds['land-gauntlet/branch'].gates.tsc.n, 4);
});

test('checksGoal (BRO-7324): only pinned split landings with all gates and an API wall count; needs 10', () => {
  const row = (wall, extra = {}) => ({ ts: '2026-11-22T00:00:00Z', branch: 'land/x', timing: { v: 1, runs: { 'land-gauntlet/branch': { wallSecs: 600, gateCount: 10 } }, checks: { nodeShard: 'artifact', dataPinned: true, wallSecs: wall, ...extra } } });
  const noise = [
    { ts: 't', branch: 'inert', timing: { v: 1, runs: {} } },
    { ts: 't', branch: 'old', timing: { 'land-gauntlet/branch': { wallSecs: 1 } } },
    row(100, { dataPinned: false }),
    row(100, { nodeShard: undefined }),
    row(null),
    { ...row(100), timing: { ...row(100).timing, runs: { 'land-gauntlet/branch': { wallSecs: 600, gateCount: 9 } } } },
    { ...row(100), timing: { ...row(100).timing, runs: { 'land-gauntlet/branch': { wallSecs: 600, gateCount: 10, scoped: true } } } },
  ];
  assert.equal(R.GOAL.gates, 10, 'goal gate count follows land-gate-delta GATES');
  assert.equal(R.checksGoalRows(noise).length, 0);
  const nine = R.checksGoal([...noise, ...Array.from({ length: 9 }, () => row(900))]);
  assert.equal(nine.ok, false); assert.equal(nine.n, 9); assert.match(nine.reason, /only 9 of 10/);
  const met = R.checksGoal([row(5000), ...Array.from({ length: 10 }, (_, i) => row(1000 + i * 30, { nodeShard: i % 2 ? 'local' : 'artifact' }))]);
  assert.equal(met.ok, true, met.reason); assert.equal(met.n, 10); assert.equal(met.medianSecs, 1135);
  const slow = R.checksGoal(Array.from({ length: 10 }, () => row(1200)));
  assert.equal(slow.ok, false); assert.match(slow.reason, /not under 1200s/);
});

test('summarizeRun: real Checks minutes and the collect step seconds from the jobs API', () => {
  const run = { id: 1, head_branch: 'land/x', status: 'completed', conclusion: 'success', run_started_at: '2026-11-21T00:00:00Z' };
  const jobs = [{ name: 'Checks', started_at: '2026-11-21T00:00:00Z', completed_at: '2026-11-21T00:24:48Z', steps: [{ name: 'Collect the node shard (part 2/2)', started_at: '2026-11-21T00:09:00Z', completed_at: '2026-11-21T00:21:26Z' }] }];
  const r = R.summarizeRun(run, jobs);
  assert.equal(r.checksMinutes, 24.8); assert.equal(r.collectSecs, 746);
  const u = R.summarizeRun(run, [{ name: 'Checks', started_at: '2026-11-21T00:00:00Z', completed_at: '2026-11-21T00:10:00Z', steps: [] }]);
  assert.equal(u.checksMinutes, 10); assert.equal(u.collectSecs, null);
});

// BRO-7324: the Land job runs every changed *.test.mjs (colocated-tests, no baseline), so the
// red-by-design goal probe must SKIP until its RECHECK-AFTER date or it refuses its own landing
// and every merge train it rides in (run 44952545959, CHECKABLE_FROM was the landing day).
test('goal probe date is past the first possible pinned split row, and the probe skips before it', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const probe = path.join(root, 'scripts', 'verify-land-checks-goal.test.mjs');
  const m = /CHECKABLE_FROM = Date\.parse\('([^']+)'\)/.exec(fs.readFileSync(probe, 'utf8'));
  assert.ok(m, 'CHECKABLE_FROM not found in the probe');
  const from = Date.parse(m[1]);
  // Ten pinned split rows cannot exist before the first row that carries timing.checks.
  const { readLandings } = require('./landings-ledger.js');
  const led = readLandings(root);
  const firsts = (led.rows || []).filter((r) => r && r.timing && r.timing.checks).map((r) => Date.parse(r.ts)).filter(Number.isFinite);
  const floor = firsts.length ? Math.min(...firsts) : Date.now();
  assert.ok(from > floor, `CHECKABLE_FROM ${m[1]} is not after ${new Date(floor).toISOString()}: the probe would be red on landing`);
  if (Date.now() >= from) return; // past the recheck date the probe judges the goal for real
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // or the child reports into this runner and prints nothing
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', probe], { encoding: 'utf8', timeout: 60_000, env });
  assert.equal(r.status, 0, `probe exited ${r.status} before ${m[1]}:\n${String(r.stdout).slice(-600)}`);
  assert.match(r.stdout, /# skipped 1/);
});
