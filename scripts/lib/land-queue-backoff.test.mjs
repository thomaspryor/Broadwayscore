import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  slotQueries, landingSlotBusy, pickStrandedCandidates, decideSweep, MAX_INSPECT,
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

test('slotQueries: every in-flight status for both landing workflows, status-filtered', () => {
  const q = slotQueries('o/r');
  for (const wf of ['land.yml', 'autonomous-merge.yml']) {
    for (const s of ['in_progress', 'queued', 'pending', 'waiting', 'requested']) {
      assert.ok(q.includes(`repos/o/r/actions/workflows/${wf}/runs?status=${s}&per_page=5`), `${wf} ${s}`);
    }
  }
  assert.equal(q[0], 'repos/o/r/actions/workflows/land.yml/runs?status=in_progress&per_page=5');
});

test('landingSlotBusy: any non-completed run is a blocker, except the run being retried', () => {
  assert.deepEqual(landingSlotBusy([]), FREE);
  assert.deepEqual(landingSlotBusy(undefined), FREE);
  // a Land run in its Checks job (in_progress) will queue a Land job later
  assert.equal(landingSlotBusy([{ id: 1, status: 'in_progress', head_branch: 'land/a' }]).busy, true);
  // autonomous-merge pending on the workflow-level group
  assert.equal(landingSlotBusy([{ id: 2, status: 'pending', head_branch: 'auto/x' }]).busy, true);
  // a re-run whose job was just queued
  assert.equal(landingSlotBusy([{ id: 3, status: 'queued', head_branch: 'land/b' }]).busy, true);
  assert.equal(landingSlotBusy([{ id: 4, status: 'waiting' }]).busy, true);
  assert.equal(landingSlotBusy([{ id: 5, status: 'completed' }]).busy, false);
  assert.deepEqual(landingSlotBusy([{ id: 7, status: 'queued' }], { selfRunId: '7' }), FREE);
  assert.deepEqual(landingSlotBusy([{ id: 9, status: 'pending', head_branch: 'land/z' }]).blockers,
    [{ id: 9, branch: 'land/z', status: 'pending' }]);
});

test('slot busy → wait, no rerun and no attempt spent', () => {
  const landRuns = [run({ id: 1, created_at: at(30) })];
  const slot = landingSlotBusy([{ id: 50, status: 'pending', head_branch: 'land/other' }]);
  const d = decideSweep({ slot, landRuns, refs: refsFor(landRuns), now: NOW });
  assert.equal(d.action, 'wait');
  assert.equal(d.reason, 'slot-busy');
  assert.equal(d.candidates, undefined);
  assert.equal(landRuns[0].run_attempt, 1);
  // no slot verdict at all is never read as free
  assert.equal(decideSweep({ landRuns, refs: refsFor(landRuns), now: NOW }).action, 'wait');
});

test('slot free → the oldest stranded run goes first', () => {
  const landRuns = [
    run({ id: 3, created_at: at(10) }),
    run({ id: 1, created_at: at(50) }),
    run({ id: 2, created_at: at(30) }),
  ];
  const d = decideSweep({ slot: FREE, landRuns, refs: refsFor(landRuns), now: NOW });
  assert.equal(d.action, 'inspect');
  assert.deepEqual(d.candidates.map((r) => r.id), [1, 2, 3]);
});

test('nothing stranded → idle', () => {
  const landRuns = [run({ id: 1, conclusion: 'success', created_at: at(5) })];
  assert.deepEqual(decideSweep({ slot: FREE, landRuns, refs: new Map(), now: NOW }), { action: 'idle', reason: 'nothing-stranded' });
});

test('pickStrandedCandidates: dead runs never sit ahead of a live one (head-of-line)', () => {
  const live = run({ id: 9, created_at: at(20), run_attempt: 2 });
  const exhausted = run({ id: 1, created_at: at(60), run_attempt: MAX_ATTEMPTS });
  const landed = run({ id: 2, created_at: at(55) });
  const superseded = run({ id: 3, created_at: at(50) });
  const tooOld = run({ id: 4, created_at: at(25 * 60) });
  const landRuns = [live, exhausted, landed, superseded, tooOld];
  const refs = refsFor(landRuns);
  refs.delete(landed.head_branch); // ref deleted → it landed
  refs.set(superseded.head_branch, 'newer-sha'); // re-pushed since
  assert.deepEqual(pickStrandedCandidates(landRuns, { refs, now: NOW }).map((r) => r.id), [9]);
});

test('pickStrandedCandidates: only the newest run per branch counts', () => {
  // an older cancelled run of a branch whose newest run failed (refused) is not stranded
  const old = run({ id: 1, head_branch: 'land/x', head_sha: 's', created_at: at(40) });
  const refused = run({ id: 2, head_branch: 'land/x', head_sha: 's', conclusion: 'failure', created_at: at(20) });
  assert.deepEqual(pickStrandedCandidates([old, refused], { refs: refsFor([old]), now: NOW }), []);
  // the reverse order: newest is the cancelled one
  const older = run({ id: 3, head_branch: 'land/y', head_sha: 't', conclusion: 'failure', created_at: at(40) });
  const newer = run({ id: 4, head_branch: 'land/y', head_sha: 't', created_at: at(20) });
  assert.deepEqual(pickStrandedCandidates([newer, older], { refs: refsFor([newer]), now: NOW }).map((r) => r.id), [4]);
  // a re-run still in flight is not a candidate
  const live = run({ id: 5, status: 'queued', conclusion: null, created_at: at(30) });
  assert.deepEqual(pickStrandedCandidates([live], { refs: refsFor([live]), now: NOW }), []);
  // non-land branches ignored; plain-object refs accepted
  const other = run({ id: 6, head_branch: 'main', created_at: at(5) });
  assert.deepEqual(pickStrandedCandidates([other], { refs: { main: other.head_sha }, now: NOW }), []);
});

test('decideSweep caps the inspected candidates', () => {
  const landRuns = Array.from({ length: MAX_INSPECT + 3 }, (_, i) => run({ id: i + 1, created_at: at(100 - i) }));
  const d = decideSweep({ slot: FREE, landRuns, refs: refsFor(landRuns), now: NOW });
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
  const js = fs.readFileSync(path.join(root, 'scripts/land-retry-cancelled.js'), 'utf8');
  // every rerun POST goes through rerun(), which is reached only after slotState() said free
  assert.equal((js.match(/rerun-failed-jobs/g) || []).length, 1);
  assert.match(js, /if \(slot\.busy\)[\s\S]*?return;[\s\S]*?rerun\(runId\)/);
  assert.match(js, /decideSweep\(\{ slot,/);
});
