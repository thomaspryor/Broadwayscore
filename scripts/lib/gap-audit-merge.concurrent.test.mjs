// Task #902 / #893 — the plan's S0 acceptance line: "`--show=X` twice
// CONCURRENTLY → no lost data".
//
// Back-to-back runs are the easy case and the per-show merge alone covers them.
// The hard case is two OVERLAPPING processes: both read the same prior file,
// both merge their own show into it, and the later write drops the earlier
// one's update — #893's data loss from a different cause. The GitHub
// concurrency group does not prevent this (a local terminal run can overlap the
// hourly cron), so the write path takes a real file lock.
//
// This test spawns REAL child processes, not simulated interleaving: N workers
// each read-merge-write their own showId into one file at the same time, and
// every one of them must survive.
//
// Run: node --test scripts/lib/gap-audit-merge.concurrent.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const LIB = path.resolve(new URL('./gap-audit-merge.js', import.meta.url).pathname);
const { withFileLock } = require('./gap-audit-merge.js');

const WORKERS = 8;

// Worker: contend for the lock, then do the same read-modify-write the audit
// does. A random-ish stagger inside the critical section widens the window a
// lost update would slip through.
const WORKER_SRC = `
const fs = require('fs');
const { mergeGapAudit, withFileLock } = require(process.argv[2]);
const target = process.argv[3];
const showId = process.argv[4];
withFileLock(target + '.lock', () => {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { prev = null; }
  // Hold the critical section open long enough that an unlocked implementation
  // would reliably interleave here.
  const until = Date.now() + 40;
  while (Date.now() < until) { /* spin */ }
  const merged = mergeGapAudit(prev, {
    generatedAt: new Date().toISOString(),
    windowDays: 21,
    targets: 1,
    results: [{ showId, title: showId, aggregatorArticles: ['https://x/a'], aggregatorListedUrls: [], missing: [], flaggedMisses: [], citedNoUrl: [] }],
  }, { retentionDays: 3650 });
  const tmp = target + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, target);
});
`;

test('N concurrent single-show runs all survive — no lost update', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-concurrent-'));
  const target = path.join(dir, 'show-review-gap.json');
  const workerPath = path.join(dir, 'worker.cjs');
  fs.writeFileSync(workerPath, WORKER_SRC);

  // Seed with one pre-existing show so we also prove carry-forward survives.
  fs.writeFileSync(target, JSON.stringify({
    generatedAt: '2026-08-01T00:00:00.000Z',
    results: [{ showId: 'seed-show', missing: [], flaggedMisses: [], citedNoUrl: [], computedAt: '2026-08-01T00:00:00.000Z' }],
  }, null, 2));

  const kids = [];
  for (let i = 0; i < WORKERS; i++) {
    kids.push(new Promise((resolve, reject) => {
      require('child_process').execFile(
        process.execPath, [workerPath, LIB, target, `show-${i}`],
        (err, _stdout, stderr) => (err ? reject(new Error(`${err.message} ${stderr}`)) : resolve())
      );
    }));
  }
  // Synchronous test body: drain with execFileSync-style waiting via a busy
  // Promise.all is not possible, so re-run them serially is NOT what we want.
  // Instead: block on the child PIDs using a tiny wait loop over the promises.
  return Promise.all(kids).then(() => {
    const final = JSON.parse(fs.readFileSync(target, 'utf8'));
    const ids = new Set(final.results.map(r => r.showId));
    const missing = [];
    for (let i = 0; i < WORKERS; i++) if (!ids.has(`show-${i}`)) missing.push(`show-${i}`);
    assert.deepStrictEqual(missing, [], `lost ${missing.length}/${WORKERS} concurrent updates — the write path is not serialized`);
    assert.ok(ids.has('seed-show'), 'pre-existing entry must survive concurrent merges');
    assert.strictEqual(final.results.length, WORKERS + 1, 'no duplicate rows');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('withFileLock breaks a stale lock instead of hanging forever', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-lock-stale-'));
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, '999999 stale\n');
  // Backdate well beyond the stale threshold.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  let ranWith = null;
  withFileLock(lock, (held) => { ranWith = held; }, { timeoutMs: 2000, staleMs: 60_000 });
  assert.strictEqual(ranWith, true, 'a stale lock must be broken and the work must run holding the lock');
  assert.strictEqual(fs.existsSync(lock), false, 'lock released on exit');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('racing stale-lock breakers: only ONE wins, and a live successor lock is never deleted', () => {
  // The blind-unlink version of the stale break had a TOCTOU hole: between
  // judging a lock stale and unlinking it, the owner could release and a NEW
  // process could take a fresh lock — the unlink then deleted a LIVE lock and
  // two writers ran at once, defeating the whole point. The rename-steal makes
  // exactly one racer win.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-lock-race-'));
  const lock = path.join(dir, 'r.lock');
  const worker = path.join(dir, 'steal.cjs');
  fs.writeFileSync(worker, `
    const fs = require('fs');
    const { withFileLock } = require(process.argv[2]);
    const lock = process.argv[3], marker = process.argv[4];
    withFileLock(lock, (held) => {
      if (!held) { console.log('NOTHELD'); return; }
      // Record overlap: if two processes are ever inside at once, the file
      // will contain more than one line at the same instant.
      fs.appendFileSync(marker, 'enter\\n');
      const until = Date.now() + 120; while (Date.now() < until) {}
      fs.appendFileSync(marker, 'exit\\n');
    }, { timeoutMs: 8000, staleMs: 2000, waitMs: 10 });
  `);
  // staleMs (2000ms) must EXCEED the critical section (120ms): the lock's mtime
  // is not refreshed while held, so a section longer than staleMs would let
  // waiters legitimately steal a LIVE lock. The real default is 5 min against a
  // sub-second section, so the margin holds in production — but it is a real
  // constraint on this helper, documented in withFileLock.
  // Plant a lock that is genuinely stale (60s old, well past staleMs).
  fs.writeFileSync(lock, '999999 stale\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const marker = path.join(dir, 'marker.txt');
  fs.writeFileSync(marker, '');

  const racers = Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    require('child_process').execFile(process.execPath, [worker, LIB, lock, marker],
      (err, stdout, stderr) => (err ? reject(new Error(err.message + stderr)) : resolve(stdout)));
  }));
  return Promise.all(racers).then(() => {
    const lines = fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean);
    // Strict alternation enter/exit proves the critical section was never
    // entered by two processes simultaneously.
    let inside = 0;
    for (const l of lines) {
      if (l === 'enter') inside++;
      else inside--;
      assert.ok(inside <= 1, 'two processes were inside the critical section at once — stale-break race');
      assert.ok(inside >= 0, 'unbalanced enter/exit');
    }
    assert.strictEqual(fs.existsSync(lock), false, 'lock released at the end');
    assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.includes('.stale-')), [], 'no orphaned steal files');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('withFileLock still runs the work (fail-open) when the lock cannot be taken', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-lock-open-'));
  const lock = path.join(dir, 'y.lock');
  fs.writeFileSync(lock, `${process.pid} fresh\n`); // fresh, never goes stale within the timeout
  let ranWith = 'never';
  withFileLock(lock, (held) => { ranWith = held; }, { timeoutMs: 300, staleMs: 60 * 60 * 1000, waitMs: 20 });
  assert.strictEqual(ranWith, false, 'work must still run — blocking the audit forever is worse than the race');
  assert.strictEqual(fs.existsSync(lock), true, 'someone else\'s lock must not be deleted');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('withFileLock releases the lock even when the work throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-lock-throw-'));
  const lock = path.join(dir, 'z.lock');
  assert.throws(() => withFileLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(fs.existsSync(lock), false, 'a thrown error must not leave the lock behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

// keep execFileSync import used (lint): assert the lib is requireable as CJS
test('gap-audit-merge is requireable from a child process', () => {
  const out = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(LIB)}); console.log('ok')`], { encoding: 'utf8' });
  assert.match(out, /ok/);
});
