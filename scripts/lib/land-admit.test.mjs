import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { decideAdmit, isMainRedBranch, isPriorityLaneActive } = require('./land-admit.js');
const { decideSweep, landJobInSlot } = require('./land-queue-backoff.js');

const NOW = Date.parse('2026-10-11T22:00:00Z');
const min = (m) => new Date(NOW - m * 60000).toISOString();
const run = (id, branch, o = {}) => ({ id, head_branch: branch, head_sha: `sha${id}`, status: 'completed', conclusion: 'success', run_attempt: 1, created_at: min(30), updated_at: min(30), path: '.github/workflows/land.yml', ...o });
const MR = 'land/main-red-bro-5079-test-fix';

test('isMainRedBranch only matches land/** branches naming main-red', () => {
  assert.equal(isMainRedBranch(MR), true);
  assert.equal(isMainRedBranch('land/bro-5079-fix'), false);
  assert.equal(isMainRedBranch('main-red'), false);
});

test('main-red lane is admitted immediately', () => {
  assert.deepEqual(decideAdmit({ selfBranch: MR, selfRunId: 1, runs: [run(2, 'land/x', { status: 'in_progress', conclusion: null })] }), { admit: true, reason: 'main-red-priority' });
});

test('ordinary lane waits while a main-red lane is pending or evicted', () => {
  const pending = run(9, MR, { status: 'in_progress', conclusion: null });
  assert.equal(decideAdmit({ selfBranch: 'land/a', selfRunId: 1, runs: [pending], now: NOW }).admit, false);
  const evicted = run(9, MR, { conclusion: 'cancelled' });
  assert.equal(decideAdmit({ selfBranch: 'land/a', selfRunId: 1, runs: [evicted], now: NOW }).admit, false);
});

test('ordinary lane is admitted once the main-red lane landed, failed, went stale or was re-pushed', () => {
  const go = (r, extra = []) => decideAdmit({ selfBranch: 'land/a', selfRunId: 1, runs: [r, ...extra], now: NOW }).admit;
  assert.equal(go(run(9, MR)), true, 'landed');
  assert.equal(go(run(9, MR, { conclusion: 'failure' })), true, 'red');
  assert.equal(go(run(9, MR, { conclusion: 'cancelled', updated_at: min(240), created_at: min(240) })), true, 'stale > 3h');
  // an older cancelled run superseded by a newer successful run of the same branch
  assert.equal(go(run(9, MR, { conclusion: 'cancelled', created_at: min(60) }), [run(10, MR, { created_at: min(10) })]), true, 'superseded');
});

test('fail-open: unreadable listing admits', () => {
  assert.equal(decideAdmit({ selfBranch: 'land/a', selfRunId: 1, runs: undefined }).admit, true);
});

test('a lane waiting in admit holds no seat; after admit it does', () => {
  const j = (admit) => [{ name: 'Checks', status: 'completed' }, { name: 'Admit', ...admit }, { name: 'Land', status: 'queued' }];
  assert.equal(landJobInSlot(j({ status: 'in_progress' })), false);
  assert.equal(landJobInSlot(j({ status: 'completed', conclusion: 'success' })), true);
  assert.equal(landJobInSlot([{ name: 'Checks', status: 'completed' }, { name: 'Land', status: 'queued' }]), true, 'pre-admit runs unchanged');
});

// Replay of 2026-10-11: BRO-5079's lane was evicted by every newer ordinary
// lane. With admit, ordinary lanes arriving while it is stranded wait, and the
// sweep re-runs it even though ordinary lanes are pending.
test('replay 2026-10-11: ordinary pushes never evict the main-red lane; sweep prefers it', () => {
  const stranded = run(38171633112, MR, { conclusion: 'cancelled', updated_at: min(40), created_at: min(100) });
  const arrivals = ['land/bro-5001-a', 'land/bro-5002-b', 'land/bro-5003-c', 'land/bro-5004-d'];
  let evictionsOfMainRed = 0;
  const admitted = [];
  for (const [i, b] of arrivals.entries()) {
    const d = decideAdmit({ selfBranch: b, selfRunId: 100 + i, runs: [stranded], now: NOW });
    if (d.admit) { admitted.push(b); evictionsOfMainRed += 1; }
  }
  assert.equal(evictionsOfMainRed, 0);
  assert.deepEqual(admitted, []);
  // Sweep: seat busy with a pending ordinary lane; both an ordinary and the main-red run are stranded.
  const ordinary = run(555, 'land/bro-5000-old', { conclusion: 'cancelled', updated_at: min(90), created_at: min(200) });
  const refs = new Map([[MR, stranded.head_sha], ['land/bro-5000-old', ordinary.head_sha]]);
  const slot = { busy: true, pending: true, blockers: [{ id: 1, branch: 'land/bro-5009-z', status: 'queued', why: 'holds-slot' }], rerunInFlight: false };
  const d = decideSweep({ slot, cancelledRuns: [ordinary, stranded], refs, now: NOW });
  assert.equal(d.action, 'inspect');
  assert.equal(d.candidates[0].id, stranded.id, 'main-red lane is re-run before an older ordinary lane');
});

test('sweep: with a main-red lane pending, ordinary stranded runs wait', () => {
  const ordinary = run(555, 'land/bro-5000-old', { conclusion: 'cancelled', updated_at: min(90), created_at: min(200) });
  const refs = new Map([['land/bro-5000-old', ordinary.head_sha]]);
  const slot = { busy: true, pending: true, blockers: [{ id: 2, branch: MR, status: 'queued', why: 'holds-slot' }], rerunInFlight: false };
  assert.equal(decideSweep({ slot, cancelledRuns: [ordinary], refs, now: NOW }).action, 'wait');
});

test('workflow wiring: admit job precedes Land, which fails open', () => {
  const y = readFileSync(new URL('../../.github/workflows/land.yml', import.meta.url), 'utf8');
  assert.match(y, /\n  admit:\n    name: Admit\n    needs: checks/);
  assert.match(y, /\n  land:\n    name: Land\n    needs: \[checks, admit\]\n    if: \$\{\{ !cancelled\(\) && needs\.checks\.result == 'success' \}\}/);
  assert.match(y, /run: node scripts\/land-admit\.js/);
  assert.ok(!/\n  admit:[\s\S]*?concurrency:[\s\S]*?\n  land:/.test(y), 'admit must stay outside the landing group');
});
