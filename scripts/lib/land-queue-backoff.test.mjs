import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { listedRunRefusal, pickStrandedCandidates, supersededByNewerRun, decideSweep, sweepStep, MAX_INSPECT } = require('./land-queue-backoff.js');
const { MAX_ATTEMPTS } = require('./land-retry-on-cancel.js');

const NOW = Date.parse('2026-10-05T02:00:00Z');
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const run = (o) => ({
  status: 'completed', conclusion: 'cancelled', run_attempt: 1, ...o,
  head_branch: o.head_branch || `land/${o.id}`, head_sha: o.head_sha || `sha${o.id}`,
});
// Every ref still at the sha its run verified, unless a test says otherwise.
const refsFor = (runs) => new Map(runs.map((r) => [r.head_branch, r.head_sha]));

test('the oldest stranded run goes first', () => {
  const cancelledRuns = [
    run({ id: 3, created_at: at(10) }),
    run({ id: 1, created_at: at(50) }),
    run({ id: 2, created_at: at(30) }),
  ];
  const d = decideSweep({ cancelledRuns, refs: refsFor(cancelledRuns), now: NOW });
  assert.equal(d.action, 'inspect');
  assert.deepEqual(d.candidates.map((r) => r.id), [1, 2, 3]);
});

test('nothing stranded → idle', () => {
  const cancelledRuns = [run({ id: 1, conclusion: 'success', created_at: at(5) })];
  assert.deepEqual(decideSweep({ cancelledRuns, refs: new Map(), now: NOW }), { action: 'idle', reason: 'nothing-stranded' });
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

test('a dozen older dead candidates no longer hide a parked one (BRO-6276)', () => {
  const cancelledRuns = Array.from({ length: 13 }, (_, i) => run({ id: i + 1, created_at: at(200 - i) }));
  const d = decideSweep({ cancelledRuns, refs: refsFor(cancelledRuns), now: NOW });
  assert.equal(d.candidates.at(-1).id, 13);
  assert.ok(MAX_INSPECT >= 33, 'covers the 33 candidates seen live on 2026-10-26');
});

test('decideSweep caps the inspected candidates', () => {
  const cancelledRuns = Array.from({ length: MAX_INSPECT + 3 }, (_, i) => run({ id: i + 1, created_at: at(100 - i) }));
  const d = decideSweep({ cancelledRuns, refs: refsFor(cancelledRuns), now: NOW });
  assert.equal(d.candidates.length, MAX_INSPECT);
  assert.equal(d.candidates[0].id, 1);
});

test('main-red stranded runs go before older ordinary ones', () => {
  const ordinary = run({ id: 1, created_at: at(50) });
  const mainRed = run({ id: 2, head_branch: 'land/main-red-bro-1', created_at: at(10) });
  const d = decideSweep({ cancelledRuns: [ordinary, mainRed], refs: refsFor([ordinary, mainRed]), now: NOW });
  assert.deepEqual(d.candidates.map((r) => r.id), [2, 1]);
});

// BRO-5112: no shared `landing` seat any more. The Land job's group is per
// branch and the fast-forward waits in the landing mutex; the sweep no longer
// scans for a slot holder.
test('wiring (BRO-5112): per-branch Land group, mutex around land.js, sweep without a slot check', () => {
  const root = new URL('../../', import.meta.url);
  const land = readFileSync(new URL('.github/workflows/land.yml', root), 'utf8');
  assert.match(land, /group: landing-\$\{\{ github\.event\.inputs\.branch \|\| github\.ref_name \}\}/);
  assert.doesNotMatch(land, /group: landing\s*$/m);
  assert.match(land, /node scripts\/land-mutex\.js acquire[\s\S]*?- name: Land the branch[\s\S]*?- name: Release the landing mutex\s+[\s\S]*?if: always\(\)[\s\S]*?node scripts\/land-mutex\.js release/);
  const merge = readFileSync(new URL('.github/workflows/autonomous-merge.yml', root), 'utf8');
  assert.match(merge, /land-mutex\.js acquire[\s\S]*?- name: Run merge\/revert[\s\S]*?if: always\(\)\s+run: node scripts\/land-mutex\.js release/);
  const wf = readFileSync(new URL('.github/workflows/land-retry-cancelled.yml', root), 'utf8');
  assert.match(wf, /--sweep/);
  assert.match(wf, /group: land-retry-sweep/);
  const js = readFileSync(new URL('scripts/land-retry-cancelled.js', root), 'utf8');
  assert.equal((js.match(/rerun-failed-jobs/g) || []).length, 1);
  assert.doesNotMatch(js, /slotState|scanSlot/);
  assert.match(js, /decideSweep\(\{ cancelledRuns,/);
  assert.match(js, /supersededByNewerRun\(/);
  // the retry decision uses the fresh per-branch run, not the possibly stale listing
  assert.match(js, /decideLandRetry\(\{ run: fresh,/);
  // BRO-6276: dead candidates are refused on their own jobs before the per-branch
  // lookup, and listing reads are shared across candidates
  assert.match(js, /listedRunRefusal\(run, \{ jobsOf, refs \}\)[\s\S]*?if \(refusal\)[\s\S]*?readLatestLandRun\(run\.head_branch/);
  assert.match(js, /read: readListing/);
});

// BRO-6015: walk a sweep's eligible candidates through sweepStep, as runSweep does.
// Like runSweep, the resume room is only read on the first parked candidate.
const walk = (kinds, room) => {
  const st = { resumed: 0, evictionRerun: false };
  let slots;
  const out = [];
  for (const k of kinds) {
    if (k === 'P' && slots === undefined) slots = room;
    const step = sweepStep({ parked: k === 'P', slots, ...st });
    out.push(step);
    if (step === 'stop') break;
    if (step === 'resume') st.resumed += 1;
    if (step === 'rerun') st.evictionRerun = true;
  }
  return out.join(',');
};

test('sweepStep: parked runs fill the resume slots oldest first; extra ones wait', () => {
  assert.equal(walk(['P', 'P', 'P'], 2), 'resume,resume,skip');
  assert.equal(walk(['P', 'P'], 0), 'skip,skip');
});

test('sweepStep: an eviction behind parked runs still re-runs, full queue or not (review P1)', () => {
  assert.equal(walk(['P', 'P', 'E'], 0), 'skip,skip,rerun');
  assert.equal(walk(['P', 'E', 'P'], 1), 'resume,rerun,stop');
  assert.equal(walk(['E', 'P', 'P'], 2), 'rerun,resume,resume');
});

test('sweepStep: at most one eviction re-run per sweep', () => {
  assert.equal(walk(['E', 'E', 'P'], 1), 'rerun,skip,resume');
  assert.equal(walk(['E', 'E'], 0), 'rerun,skip');
  // room not read yet when the second eviction comes up: it skips, never stopping the scan
  assert.equal(walk(['E', 'E', 'P'], 0), 'rerun,skip,stop');
  assert.equal(walk(['E', 'E', 'P', 'P'], 1), 'rerun,skip,resume,stop');
});

// BRO-6276: dead candidates are refused on one jobs read each, so only the parked
// run would pay for the per-branch lookup.
test('listedRunRefusal refuses dead runs on their jobs and keeps the parked one', () => {
  const landJob = (steps) => [{ name: 'Checks', conclusion: 'success' }, { name: 'Land', conclusion: 'cancelled', steps }];
  const started = landJob([{ name: 'Set up job', conclusion: 'success' }, { name: 'Rebase', conclusion: 'success' }, { name: 'Land', conclusion: 'cancelled' }]);
  const failedChecks = [{ name: 'Checks', conclusion: 'failure' }, { name: 'Land', conclusion: 'skipped', steps: [] }];
  const parked = landJob([{ name: 'Set up job', conclusion: 'success' }, { name: 'Admit to the landing queue', conclusion: 'cancelled' }, { name: 'Complete job', conclusion: 'success' }]);
  const dead = Array.from({ length: 12 }, (_, i) => run({ id: 100 + i, created_at: at(30) }));
  const live = run({ id: 999, created_at: at(30) });
  const all = [...dead, live];
  const calls = [];
  const jobsOf = (id) => { calls.push(id); return id === 999 ? parked : (id % 2 ? started : failedChecks); };
  const refs = refsFor(all);
  const out = all.map((r) => listedRunRefusal(r, { jobsOf, refs }));
  assert.equal(out.filter(Boolean).length, 12);
  assert.equal(out[12], null);
  assert.deepEqual(calls, all.map((r) => r.id));
});
