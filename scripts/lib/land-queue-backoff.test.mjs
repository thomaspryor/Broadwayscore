import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  slotQueries, landJobInSlot, inFlightBlocker, pickStrandedCandidates, supersededByNewerRun,
  decideSweep, orderForSlotCheck, MAX_INSPECT, STALE_BLOCKER_HOURS, MAX_JOB_LOOKUPS,
} = require('./land-queue-backoff.js');
const { MAX_ATTEMPTS } = require('./land-retry-on-cancel.js');

const NOW = Date.parse('2026-10-05T02:00:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const run = (o) => ({
  status: 'completed', conclusion: 'cancelled', run_attempt: 1, ...o,
  head_branch: o.head_branch || `land/${o.id}`, head_sha: o.head_sha || `sha${o.id}`,
});
// Every ref still at the sha its run verified, unless a test says otherwise.
const refsFor = (runs) => new Map(runs.map((r) => [r.head_branch, r.head_sha]));
const FREE = { busy: false, blockers: [] };
const LAND = '.github/workflows/land.yml';
const MERGE = '.github/workflows/autonomous-merge.yml';
const inChecks = [{ name: 'Checks', status: 'in_progress' }, { name: 'Land', status: 'pending' }];
const landPending = [{ name: 'Checks', status: 'completed' }, { name: 'Land', status: 'queued' }];
const landRunning = [{ name: 'Checks', status: 'completed' }, { name: 'Land', status: 'in_progress' }];

test('slotQueries: every in-flight status for both landing workflows, status-filtered', () => {
  const q = slotQueries('o/r');
  for (const wf of ['land.yml', 'autonomous-merge.yml']) {
    for (const s of ['in_progress', 'queued', 'pending', 'waiting', 'requested']) {
      assert.ok(q.includes(`repos/o/r/actions/workflows/${wf}/runs?status=${s}&per_page=20`), `${wf} ${s}`);
    }
  }
  assert.equal(q[0], 'repos/o/r/actions/workflows/land.yml/runs?status=in_progress&per_page=20');
});

test('landJobInSlot: only a Land job past Checks and not finished holds the slot', () => {
  assert.equal(landJobInSlot(landPending), true);
  assert.equal(landJobInSlot(landRunning), true);
  assert.equal(landJobInSlot(inChecks), false);
  assert.equal(landJobInSlot([{ name: 'Checks', status: 'completed' }, { name: 'Land', status: 'completed' }]), false);
  assert.equal(landJobInSlot([{ name: 'Checks', status: 'completed' }]), false);
  assert.equal(landJobInSlot(undefined), false);
});

test('inFlightBlocker: job-level for Land, whole-run for Autonomous Merge', () => {
  const o = { now: NOW };
  // autonomous-merge's group is workflow-level: any in-flight run holds the slot
  assert.equal(inFlightBlocker({ id: 1, status: 'pending', path: MERGE, created_at: at(5) }, o), 'busy');
  // a Land run needs its jobs to decide
  const land = { id: 2, status: 'in_progress', path: LAND, created_at: at(5) };
  assert.equal(inFlightBlocker(land, o), 'needs-jobs');
  // still in Checks → does not hold the slot (no starvation while pushes keep arriving)
  assert.equal(inFlightBlocker(land, { ...o, jobs: inChecks }), 'clear');
  assert.equal(inFlightBlocker(land, { ...o, jobs: landPending }), 'busy');
  assert.equal(inFlightBlocker(land, { ...o, jobs: landRunning }), 'busy');
  // the run being retried never blocks itself
  assert.equal(inFlightBlocker({ id: 7, status: 'queued', path: LAND, created_at: at(5) }, { ...o, selfRunId: '7' }), 'clear');
  assert.equal(inFlightBlocker({ id: 8, status: 'completed', path: MERGE }, o), 'clear');
  // stuck for hours → ignored, never a permanent block
  const stuck = { id: 9, status: 'queued', path: MERGE, created_at: at(STALE_BLOCKER_HOURS * 60 + 1) };
  assert.equal(inFlightBlocker(stuck, o), 'stale');
  // a re-run's run_started_at is what counts, not its original created_at
  assert.equal(inFlightBlocker({ ...stuck, run_started_at: at(5) }, o), 'busy');
});

test('orderForSlotCheck: likeliest holders first, so a 12-run burst stays under the lookup cap', () => {
  const runs = [
    { id: 1, path: LAND, status: 'in_progress', run_attempt: 1, run_started_at: at(5) },
    { id: 2, path: LAND, status: 'in_progress', run_attempt: 1, run_started_at: at(30) },
    { id: 3, path: LAND, status: 'pending', run_attempt: 1, run_started_at: at(1) },
    { id: 4, path: LAND, status: 'in_progress', run_attempt: 3, run_started_at: at(2) },
    { id: 5, path: MERGE, status: 'in_progress', run_attempt: 1, run_started_at: at(1) },
  ];
  assert.deepEqual(orderForSlotCheck(runs).map((r) => r.id), [5, 4, 3, 2, 1]);
  assert.deepEqual(orderForSlotCheck(undefined), []);
  // the 2026-10-05 burst: 12 land.yml runs in flight at once
  assert.ok(MAX_JOB_LOOKUPS >= 20);
});

test('slot busy → wait, no rerun and no attempt spent', () => {
  const cancelledRuns = [run({ id: 1, created_at: at(30) })];
  const slot = { busy: true, blockers: [{ id: 50, branch: 'land/other', status: 'queued', why: 'holds-slot' }] };
  const d = decideSweep({ slot, cancelledRuns, refs: refsFor(cancelledRuns), now: NOW });
  assert.equal(d.action, 'wait');
  assert.equal(d.reason, 'slot-busy');
  assert.equal(d.candidates, undefined);
  assert.deepEqual(d.blockers, slot.blockers);
  assert.equal(cancelledRuns[0].run_attempt, 1);
  // no slot verdict at all is never read as free
  assert.equal(decideSweep({ cancelledRuns, refs: refsFor(cancelledRuns), now: NOW }).action, 'wait');
});

test('slot free → the oldest stranded run goes first', () => {
  const cancelledRuns = [
    run({ id: 3, created_at: at(10) }),
    run({ id: 1, created_at: at(50) }),
    run({ id: 2, created_at: at(30) }),
  ];
  const d = decideSweep({ slot: FREE, cancelledRuns, refs: refsFor(cancelledRuns), now: NOW });
  assert.equal(d.action, 'inspect');
  assert.deepEqual(d.candidates.map((r) => r.id), [1, 2, 3]);
});

test('nothing stranded → idle', () => {
  const cancelledRuns = [run({ id: 1, conclusion: 'success', created_at: at(5) })];
  assert.deepEqual(decideSweep({ slot: FREE, cancelledRuns, refs: new Map(), now: NOW }), { action: 'idle', reason: 'nothing-stranded' });
});

test('pickStrandedCandidates: dead runs never sit ahead of a live one (head-of-line)', () => {
  const live = run({ id: 9, created_at: at(20), run_attempt: 2 });
  const exhausted = run({ id: 1, created_at: at(60), run_attempt: MAX_ATTEMPTS });
  const landed = run({ id: 2, created_at: at(55) });
  const superseded = run({ id: 3, created_at: at(50) });
  const tooOld = run({ id: 4, created_at: at(25 * 60) });
  const cancelledRuns = [live, exhausted, landed, superseded, tooOld];
  const refs = refsFor(cancelledRuns);
  refs.delete(landed.head_branch); // ref deleted → it landed
  refs.set(superseded.head_branch, 'newer-sha'); // re-pushed since
  assert.deepEqual(pickStrandedCandidates(cancelledRuns, { refs, now: NOW }).map((r) => r.id), [9]);
});

test('pickStrandedCandidates: newest cancelled run per branch; in-flight and non-land ignored', () => {
  const older = run({ id: 3, head_branch: 'land/y', head_sha: 't', created_at: at(40) });
  const newer = run({ id: 4, head_branch: 'land/y', head_sha: 't', created_at: at(20) });
  assert.deepEqual(pickStrandedCandidates([older, newer], { refs: refsFor([newer]), now: NOW }).map((r) => r.id), [4]);
  const live = run({ id: 5, status: 'queued', conclusion: null, created_at: at(30) });
  assert.deepEqual(pickStrandedCandidates([live], { refs: refsFor([live]), now: NOW }), []);
  // plain-object refs accepted; non-land branches ignored
  const other = run({ id: 6, head_branch: 'main', created_at: at(5) });
  assert.deepEqual(pickStrandedCandidates([other], { refs: { main: other.head_sha }, now: NOW }), []);
});

test('supersededByNewerRun: a refused or re-pushed newer run on the branch wins', () => {
  const cand = run({ id: 1, head_branch: 'land/x', created_at: at(40) });
  assert.equal(supersededByNewerRun(cand, { id: 2, conclusion: 'failure' }), true);
  assert.equal(supersededByNewerRun(cand, { id: 1 }), false);
  assert.equal(supersededByNewerRun(cand, undefined), false);
});

test('decideSweep caps the inspected candidates', () => {
  const cancelledRuns = Array.from({ length: MAX_INSPECT + 3 }, (_, i) => run({ id: i + 1, created_at: at(100 - i) }));
  const d = decideSweep({ slot: FREE, cancelledRuns, refs: refsFor(cancelledRuns), now: NOW });
  assert.equal(d.candidates.length, MAX_INSPECT);
  assert.equal(d.candidates[0].id, 1);
});

test('wiring: the workflow sweeps when the slot frees and the script spends attempts only via the slot check', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const wf = fs.readFileSync(path.join(root, '.github/workflows/land-retry-cancelled.yml'), 'utf8');
  assert.match(wf, /workflows: \['Land', 'Autonomous Merge'\]/);
  assert.match(wf, /- cron:/);
  assert.match(wf, /--sweep/);
  assert.match(wf, /group: land-retry-sweep/);
  assert.match(wf, /cancel-in-progress: false/);
  const js = fs.readFileSync(path.join(root, 'scripts/land-retry-cancelled.js'), 'utf8');
  // every rerun POST goes through rerun(), reached only after slotState() said free
  assert.equal((js.match(/rerun-failed-jobs/g) || []).length, 1);
  assert.match(js, /const slot = slotState\(runId\);\s*if \(slot\.busy\)[\s\S]*?return;[\s\S]*?rerun\(runId\)/);
  assert.match(js, /const slot = slotState\(\);\s*if \(slot\.busy\)[\s\S]*?return;/);
  assert.match(js, /decideSweep\(\{ slot,/);
  assert.match(js, /supersededByNewerRun\(/);
  assert.match(js, /inFlightBlocker\(/);
  assert.match(js, /orderForSlotCheck\(/);
});
