import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  scanSlot, FAST_RETRY_MAX_ATTEMPT, FAST_RETRY_MINUTES, slotQueries, landJobInSlot, slotHolderKind, inFlightBlocker, pickStrandedCandidates, supersededByNewerRun,
  decideSweep, orderForSlotCheck, MAX_INSPECT, STALE_BLOCKER_HOURS, MAX_JOB_LOOKUPS, AGED_RETRY_MINUTES,
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
  // Checks done, Land job not created yet: about to enter the slot
  assert.equal(landJobInSlot([{ name: 'Checks', status: 'completed' }]), true);
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

test('BRO-4676: slot busy + stranded run past the aging threshold → re-run it anyway', () => {
  const busy = { busy: true, blockers: [{ id: 50, branch: 'land/other', status: 'queued', why: 'holds-slot' }] };
  const old = run({ id: 1, created_at: at(95), updated_at: at(AGED_RETRY_MINUTES + 5) });
  const young = run({ id: 2, created_at: at(20), updated_at: at(10) });
  const runs = [young, old];
  const d = decideSweep({ slot: busy, cancelledRuns: runs, refs: refsFor(runs), now: NOW });
  assert.equal(d.action, 'inspect');
  assert.equal(d.aged, true);
  assert.deepEqual(d.candidates.map((r) => r.id), [1], 'only the aged run; the young one keeps waiting');
});

test('BRO-4676: a re-run already in flight blocks another aged re-run (no eviction at sweep speed)', () => {
  const busy = { busy: true, rerunInFlight: true, blockers: [] };
  const a = run({ id: 1, created_at: at(200), updated_at: at(100) });
  const b = run({ id: 2, created_at: at(190), updated_at: at(90) });
  const d = decideSweep({ slot: busy, cancelledRuns: [a, b], refs: refsFor([a, b]), now: NOW });
  assert.deepEqual([d.action, d.reason], ['wait', 'rerun-in-flight']);
});

test('BRO-4676: slot busy + only young stranded runs → wait', () => {
  const busy = { busy: true, blockers: [] };
  const runs = [run({ id: 1, created_at: at(90), updated_at: at(AGED_RETRY_MINUTES - 1) }), run({ id: 2, created_at: at(5) })];
  assert.equal(decideSweep({ slot: busy, cancelledRuns: runs, refs: refsFor(runs), now: NOW }).action, 'wait');
});

test('BRO-4676: aging is measured from the latest cancel, and exhausted/landed runs never age in', () => {
  const busy = { busy: true, blockers: [] };
  const recancelled = run({ id: 1, created_at: at(300), updated_at: at(5) }); // re-run, evicted again 5 min ago
  const exhausted = run({ id: 2, created_at: at(200), updated_at: at(100), run_attempt: MAX_ATTEMPTS });
  const runs = [recancelled, exhausted];
  assert.equal(decideSweep({ slot: busy, cancelledRuns: runs, refs: refsFor(runs), now: NOW }).action, 'wait');
  // no slot verdict at all stays a plain wait even with an aged run
  const old = run({ id: 3, created_at: at(200), updated_at: at(100) });
  assert.equal(decideSweep({ cancelledRuns: [old], refs: refsFor([old]), now: NOW }).action, 'wait');
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
  assert.match(js, /const slot = slotState\(runId\);\s*if \(slot\.busy\)[\s\S]*?return;[\s\S]*?rerun\(runId\b/);
  assert.match(js, /const slot = slotState\(\);[\s\S]*?decideSweep\(/);
  assert.match(js, /d\.action === 'wait'/);
  assert.match(js, /decideSweep\(\{ slot,/);
  assert.match(js, /supersededByNewerRun\(/);
  assert.match(js, /scanSlot\(/);
  // the retry decision uses the fresh per-branch run, not the possibly stale listing
  assert.match(js, /decideLandRetry\(\{ run: fresh,/);
});

test('BRO-4677: slotHolderKind — only an in_progress Land job / autonomous-merge run is "running"', () => {
  assert.equal(slotHolderKind({ path: LAND }, landRunning), 'running');
  assert.equal(slotHolderKind({ path: LAND }, landPending), 'pending');
  assert.equal(slotHolderKind({ path: LAND }, [{ name: 'Checks', status: 'completed' }]), 'pending', 'Checks done, no Land job yet: about to take the slot');
  assert.equal(slotHolderKind({ path: LAND }, undefined), 'pending');
  assert.equal(slotHolderKind({ path: MERGE, status: 'in_progress' }), 'running');
  assert.equal(slotHolderKind({ path: MERGE, status: 'queued' }), 'pending');
});

test('BRO-4677: slot busy but pending seat empty → oldest stranded run goes now, no aging needed', () => {
  const held = { busy: true, pending: false, blockers: [{ id: 50, branch: 'land/other', status: 'in_progress', why: 'running' }] };
  const newer = run({ id: 2, created_at: at(20), updated_at: at(5) });
  const oldest = run({ id: 1, created_at: at(40), updated_at: at(8) });
  const runs = [newer, oldest];
  const d = decideSweep({ slot: held, cancelledRuns: runs, refs: refsFor(runs), now: NOW });
  assert.deepEqual([d.action, d.reason], ['inspect', 'no-pending-slot-busy']);
  assert.deepEqual(d.candidates.map((r) => r.id), [1, 2], 'oldest first');
});

test('BRO-4677: fast path is throttled: spacing and attempt cap, then aging takes over', () => {
  const held = { busy: true, pending: false, blockers: [] };
  const fresh = run({ id: 1, created_at: at(60), updated_at: at(FAST_RETRY_MINUTES - 1) });
  const spent = run({ id: 2, created_at: at(90), updated_at: at(AGED_RETRY_MINUTES - 5), run_attempt: FAST_RETRY_MAX_ATTEMPT + 1 });
  const ok = run({ id: 3, created_at: at(90), updated_at: at(FAST_RETRY_MINUTES + 1), run_attempt: FAST_RETRY_MAX_ATTEMPT });
  const all = [fresh, spent, ok];
  const d = decideSweep({ slot: held, cancelledRuns: all, refs: refsFor(all), now: NOW });
  assert.deepEqual(d.candidates.map((r) => r.id), [3]);
  const only = [fresh, spent];
  assert.equal(decideSweep({ slot: held, cancelledRuns: only, refs: refsFor(only), now: NOW }).action, 'wait');
  const aged = run({ id: 4, created_at: at(200), updated_at: at(AGED_RETRY_MINUTES + 1), run_attempt: FAST_RETRY_MAX_ATTEMPT + 1 });
  assert.equal(decideSweep({ slot: held, cancelledRuns: [aged], refs: refsFor([aged]), now: NOW }).reason, 'aged-slot-busy');
});

test('BRO-4677: scanSlot — running only → pending:false; later pending → pending:true; cap/free/stale', () => {
  const mkRun = (id, status, extra = {}) => ({ id, path: LAND, status, head_branch: `land/${id}`, run_started_at: at(5), created_at: at(5), ...extra });
  const byRun = { 1: landRunning, 2: landPending, 3: inChecks };
  const jobsOf = (id) => byRun[id];
  const scan = (runs, o = {}) => scanSlot(runs, { jobsOf, now: NOW, ...o });
  assert.equal(scan([mkRun(1, 'in_progress'), mkRun(3, 'in_progress')]).pending, false);
  assert.equal(scan([mkRun(1, 'in_progress'), mkRun(2, 'queued')]).pending, true, 'pending found after a running holder');
  assert.equal(scan([mkRun(1, 'in_progress'), mkRun(2, 'queued')], { maxLookups: 1 }).pending, true, 'cap reads as pending');
  assert.equal(scan([mkRun(3, 'in_progress')]).busy, false);
  assert.equal(scan([]).busy, false);
  const stale = mkRun(1, 'in_progress', { run_started_at: at(STALE_BLOCKER_HOURS * 60 + 5), created_at: at(STALE_BLOCKER_HOURS * 60 + 5) });
  assert.equal(scan([stale]).busy, false);
  assert.equal(scan([{ id: 9, path: MERGE, status: 'in_progress', created_at: at(5) }]).pending, false);
  assert.equal(scan([{ id: 9, path: MERGE, status: 'queued', created_at: at(5) }]).pending, true);
});

test('BRO-4677: a pending entrant (or unknown) keeps young stranded runs waiting; in-flight re-run still blocks', () => {
  const runs = [run({ id: 1, created_at: at(40), updated_at: at(8) })];
  const pending = { busy: true, pending: true, blockers: [] };
  assert.equal(decideSweep({ slot: pending, cancelledRuns: runs, refs: refsFor(runs), now: NOW }).action, 'wait');
  const unknown = { busy: true, blockers: [] };
  assert.equal(decideSweep({ slot: unknown, cancelledRuns: runs, refs: refsFor(runs), now: NOW }).action, 'wait');
  const rerun = { busy: true, pending: false, rerunInFlight: true, blockers: [] };
  assert.deepEqual(decideSweep({ slot: rerun, cancelledRuns: runs, refs: refsFor(runs), now: NOW }).reason, 'rerun-in-flight');
  // running-only but nothing stranded → falls through to wait
  const none = { busy: true, pending: false, blockers: [] };
  assert.equal(decideSweep({ slot: none, cancelledRuns: [], refs: new Map(), now: NOW }).action, 'wait');
});

test('BRO-4677: wiring — sweep scans for a pending entrant and settles after a re-run', async () => {
  const { readFileSync } = await import('node:fs');
  const js = readFileSync(new URL('../land-retry-cancelled.js', import.meta.url), 'utf8');
  assert.match(js, /scanSlot\(/);
  assert.match(js, /ghRaw\(\['-X', 'POST'[\s\S]*?settle\(id\)/);
});
