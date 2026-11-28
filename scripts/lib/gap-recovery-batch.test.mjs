// BRO-7944: chained batch runner decisions. Run: node --test scripts/lib/gap-recovery-batch.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = require('./gap-recovery-batch.js');

test('checkpointCadence: defaults, env override, and the 10 accepts / 10 minutes ceiling', () => {
  assert.deepEqual(B.checkpointCadence({}), { everyAccepts: 5, maxMs: 120000 });
  assert.deepEqual(B.checkpointCadence({ GAP_CHECKPOINT_EVERY: '3', GAP_CHECKPOINT_MAX_MIN: '1' }), { everyAccepts: 3, maxMs: 60000 });
  assert.deepEqual(B.checkpointCadence({ GAP_CHECKPOINT_EVERY: '500', GAP_CHECKPOINT_MAX_MIN: '99' }), { everyAccepts: 10, maxMs: 600000 });
  assert.deepEqual(B.checkpointCadence({ GAP_CHECKPOINT_EVERY: 'x', GAP_CHECKPOINT_MAX_MIN: '-4' }), { everyAccepts: 5, maxMs: 120000 });
});

test('orphanAccepts: uncommitted text of the accepted length is adopted; landed skipped; missing/clean reported gone', () => {
  const pending = new Map([
    ['s/a.json', { bytesAfter: 5 }], ['s/b.json', { bytesAfter: 5 }], ['s/c.json', { bytesAfter: 5 }],
    ['s/d.json', { bytesAfter: 5 }], ['s/e.json', { bytesAfter: 5 }],
  ]);
  const files = { 's/a.json': 'hello', 's/b.json': 'hello', 's/c.json': 'hellooo', 's/e.json': 'hello' };
  const dirty = { 's/a.json': true, 's/b.json': true, 's/c.json': true, 's/e.json': false };
  const r = B.orphanAccepts(pending, { readText: (k) => (k in files ? files[k] : null), isDirty: (k) => !!dirty[k], landed: new Set(['s/b.json']) });
  assert.deepEqual(r.adopt, ['s/a.json']);
  assert.deepEqual(r.gone, ['s/c.json', 's/d.json', 's/e.json']); // c = dirty but length differs
});

test('stopDecision: two failed pushes, either spend cap, rounds done, an idle round', () => {
  const base = { failedPushes: 0, spend: { bd: 0, serp: 0 }, cap: { bd: 25, serp: 60 }, roundsDone: 1, rounds: 3, lastRoundWork: 4 };
  assert.equal(B.stopDecision(base).stop, false);
  assert.match(B.stopDecision({ ...base, failedPushes: 1 }).why || 'go', /go/);
  assert.match(B.stopDecision({ ...base, failedPushes: 2 }).why, /failed pushes/);
  assert.match(B.stopDecision({ ...base, spend: { bd: 25, serp: 0 } }).why, /Bright Data/);
  assert.match(B.stopDecision({ ...base, spend: { bd: 0, serp: 61 } }).why, /SERP/);
  assert.match(B.stopDecision({ ...base, roundsDone: 3 }).why, /rounds complete/);
  assert.match(B.stopDecision({ ...base, lastRoundWork: 0 }).why, /nothing eligible/);
  assert.equal(B.stopDecision({ ...base, cap: { bd: null, serp: null }, spend: { bd: 999, serp: 999 } }).stop, false);
});

test('remainingBudget + buildRoundRow', () => {
  assert.deepEqual(B.remainingBudget({ bd: 25, serp: null }, { bd: 10, serp: 5 }), { bd: 15, serp: null });
  assert.deepEqual(B.remainingBudget({ bd: 5, serp: 5 }, { bd: 10, serp: 5 }), { bd: 0, serp: 0 });
  const row = B.buildRoundRow({ batchId: 'b', round: 2, startedAt: 's', endedAt: 'e', exit: 0, summary: { attempted: 3, accepted: 1, landed: 1, byStrategy: { ARCHIVE: { attempted: 3, accepted: 1, outcomes: { x: 1 } } }, pushRetryFailed: true } });
  assert.equal(row.pushFailed, true);
  assert.deepEqual(row.byStrategy, { ARCHIVE: { attempted: 3, accepted: 1 } });
});

test('orphanAccepts: an equal-length dirty file with a different hash is NOT adopted (not our accepted text)', () => {
  const pending = new Map([['s/a.json', { bytesAfter: 5, acceptedHash: 'h-hello' }], ['s/b.json', { bytesAfter: 5, acceptedHash: 'h-world' }]]);
  const files = { 's/a.json': 'hello', 's/b.json': 'hello' };
  const r = B.orphanAccepts(pending, { readText: (k) => files[k], isDirty: () => true, hashText: (t) => `h-${t}` });
  assert.deepEqual(r.adopt, ['s/a.json']);
  assert.deepEqual(r.gone, ['s/b.json']);
});

test('BRO-7962: a round that is allowed to run never gets a 0 budget (0 means "no cap" to the driver)', () => {
  for (const cb of [null, 0, 1, 25]) for (const cs of [null, 0, 1, 60]) for (const ub of [0, 1, 24, 25, 30]) for (const us of [0, 1, 59, 60, 70]) {
    const cap = { bd: cb, serp: cs }; const spend = { bd: ub, serp: us };
    const d = B.stopDecision({ failedPushes: 0, spend, cap, roundsDone: 0, rounds: 3, lastRoundWork: 1 });
    if (d.stop) continue;
    const rem = B.remainingBudget(cap, spend);
    assert.ok(rem.bd !== 0 && rem.serp !== 0, JSON.stringify({ cap, spend, rem }));
  }
});

// BRO-8288: parallel outlet lanes. Real processes, real lock files in a scratch dir.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recovery-run-lock.js');
const { makeTmpDir } = require('./tmpdir-for-tests.js');
const lockDir = makeTmpDir(after, 'lanes-');
const lenv = { ...process.env, RECOVERY_RUN_LOCK_PATH: path.join(lockDir, 'run.lock') };
const probe = (code) => spawnSync(process.execPath, ['-e', `const L=require(${JSON.stringify(LOCK)});try{${code}}catch(e){console.log(e.code+' '+e.message)}`], { env: lenv, encoding: 'utf8' }).stdout.trim();
const holdLane = async (outlets, browser) => {
  const p = spawn(process.execPath, ['-e', `const r=require(${JSON.stringify(LOCK)}).acquireLaneLock('lane',${JSON.stringify(outlets)},{browser:${browser}});console.log('HELD '+r.browser);setTimeout(()=>{},20000)`], { env: lenv });
  const out = await new Promise((res) => p.stdout.once('data', (d) => res(String(d).trim())));
  return { p, out };
};
const kill = (h) => new Promise((res) => { h.p.once('exit', res); h.p.kill('SIGTERM'); });

test('outletsFromArgs mirrors the driver parse (--outlet=a,b)', () => {
  assert.deepEqual(B.outletsFromArgs(['--outlet=a,b', '--limit=3']), ['a', 'b']);
  assert.deepEqual(B.outletsFromArgs(['--outlet', 'x', '--outlet=y,x', '--outlet=z']), ['y', 'x'], 'mirrors the driver: first --outlet= only');
  assert.deepEqual(B.outletsFromArgs(['--outlet', 'x']), [], 'bare form is not a scope the driver honours');
  assert.deepEqual(B.outletsFromArgs(['--class=NO_URL']), []);
});

test('lanes: disjoint outlets both acquire; overlapping refused; one browser owner; nightly sees busy', async () => {
  const a = await holdLane(['nytimes', 'washpost'], true);
  const b = await holdLane(['thestage'], true);
  try {
    assert.equal(a.out, 'HELD true');
    assert.equal(b.out, 'HELD false', 'second lane runs browser-less: one Chrome');
    assert.match(probe(`L.acquireLaneLock('c',['washpost','variety'],{browser:false});console.log('ACQUIRED')`), /^ERUNLOCKBUSY/, 'overlap refused');
    assert.equal(probe(`const r=L.acquireLaneLock('c',['variety'],{browser:false});console.log('ACQUIRED');r.release()`), 'ACQUIRED', 'refused overlap left no partial locks');
    assert.match(probe(`L.acquireRunLock('gap-recovery-nightly');console.log('ACQUIRED')`), /^ERUNLOCKBUSY/, 'nightly/whole-run sees the lanes');
  } finally { await kill(a); await kill(b); }
  assert.equal(probe(`L.acquireRunLock('gap-recovery-nightly');console.log('ACQUIRED')`), 'ACQUIRED', 'dead lanes are stale');
});

test('lane refused while the whole-run lock is live; refusal leaves no lane locks', async () => {
  const w = spawn(process.execPath, ['-e', `require(${JSON.stringify(LOCK)}).acquireRunLock('nightly');console.log('HELD');setTimeout(()=>{},20000)`], { env: lenv });
  await new Promise((res) => w.stdout.once('data', res));
  try {
    assert.match(probe(`L.acquireLaneLock('c',['nytimes'],{});console.log('ACQUIRED')`), /^ERUNLOCKBUSY .*nightly/);
    assert.equal(probe(`console.log(L.readLaneHolders().filter(h=>h.alive).length)`), '0');
  } finally { await new Promise((res) => { w.once('exit', res); w.kill('SIGTERM'); }); }
});

test('class guard: lanes skip the global pending-retry/adopt steps; batch sets GAP_RECOVERY_LANE for scoped runs', () => {
  const root = path.join(path.dirname(LOCK), '..');
  const drv = fs.readFileSync(path.join(root, 'gap-recovery-driver.js'), 'utf8');
  assert.match(drv, /LANE \? \{ entries: 0[^}]*\} : retryPendingPushes\(/);
  assert.match(drv, /if \(!LANE\) try \{\s*\n\s*const \{ orphanAccepts \}/);
  assert.match(fs.readFileSync(path.join(root, 'gap-recovery-batch.js'), 'utf8'), /laneOutlets\.length \? \{ GAP_RECOVERY_LANE: '1' \}/);
});

test('roundSpend: a dry-run round spends nothing; a missing summary books the whole allowance (BRO-8277)', () => {
  const rem = { bd: 25, serp: 60 };
  assert.deepEqual(B.roundSpend({ mode: 'dry_run', attempted: 0 }, rem), { bd: 0, serp: 0 });
  assert.deepEqual(B.roundSpend({ spend: { bd: 3, serp: 7 } }, rem), { bd: 3, serp: 7 });
  assert.deepEqual(B.roundSpend(null, rem), { bd: 25, serp: 60 });
  // Live early exits (mode null) and a failed spend read (mode live, spend null) still book the whole allowance.
  assert.deepEqual(B.roundSpend({ mode: null, attempted: 0 }, rem), { bd: 25, serp: 60 });
  assert.deepEqual(B.roundSpend({ mode: 'live', spend: null }, rem), { bd: 25, serp: 60 });
  assert.deepEqual(B.roundSpend(null, { bd: null, serp: null }), { bd: 0, serp: 0 });
});
