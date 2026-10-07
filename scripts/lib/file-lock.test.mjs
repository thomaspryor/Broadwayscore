// withFileLock mechanics (moved out of gap-audit-merge.concurrent.test.mjs,
// task #923 — the helper now guards two unrelated files, not one, so its
// tests live with the helper instead of one of its callers).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const LIB = path.resolve(new URL('./file-lock.js', import.meta.url).pathname);
const { withFileLock } = require('./file-lock.js');

test('withFileLock breaks a stale lock instead of hanging forever', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-stale-'));
  const lock = path.join(dir, 'x.lock');
  fs.writeFileSync(lock, '999999 stale\n'); // pid almost certainly not alive
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  let ranWith = null;
  withFileLock(lock, (held) => { ranWith = held; }, { timeoutMs: 2000, staleMs: 60_000 });
  assert.strictEqual(ranWith, true, 'a stale lock with a dead holder must be broken and the work must run holding the lock');
  assert.strictEqual(fs.existsSync(lock), false, 'lock released on exit');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('task #923: an aged lock whose holder PID is still ALIVE is not stolen (age alone is not enough)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-alive-'));
  const lock = path.join(dir, 'alive.lock');
  // OUR OWN pid — guaranteed alive for the duration of this test — planted
  // with an old mtime, simulating a critical section that has legitimately
  // run longer than staleMs. Before #923 this was judged stale by age alone
  // and stolen out from under the still-running holder.
  fs.writeFileSync(lock, `${process.pid} old-but-alive\n`);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  let ranWith = 'never';
  withFileLock(lock, (held) => { ranWith = held; }, { timeoutMs: 300, staleMs: 1000, waitMs: 20 });
  assert.strictEqual(ranWith, false, 'must NOT steal — the recorded holder is still alive, so age alone must not trigger a steal');
  assert.strictEqual(fs.existsSync(lock), true, "a live holder's lock must not be deleted");
  fs.rmSync(dir, { recursive: true, force: true });
});

test('task #923: an aged lock whose holder PID is DEAD is stolen (both signals agree)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-dead-'));
  const lock = path.join(dir, 'dead.lock');
  // A real child process that has already exited — its pid is guaranteed
  // reusable-free at least for the instant of this test (best-effort; the
  // 999999-pid test above covers the common "obviously fake" case, this one
  // proves a REAL exited pid also gets judged not-alive).
  const exited = require('child_process').spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(lock, `${exited} exited\n`);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  let ranWith = null;
  withFileLock(lock, (held) => { ranWith = held; }, { timeoutMs: 2000, staleMs: 60_000 });
  assert.strictEqual(ranWith, true, 'both age AND pid-death agree — the lock must be stolen');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('racing stale-lock breakers: only ONE wins, and a live successor lock is never deleted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-race-'));
  const lock = path.join(dir, 'r.lock');
  const worker = path.join(dir, 'steal.cjs');
  fs.writeFileSync(worker, `
    const fs = require('fs');
    const { withFileLock } = require(process.argv[2]);
    const lock = process.argv[3], marker = process.argv[4];
    withFileLock(lock, (held) => {
      if (!held) { console.log('NOTHELD'); return; }
      fs.appendFileSync(marker, 'enter\\n');
      const until = Date.now() + 120; while (Date.now() < until) {}
      fs.appendFileSync(marker, 'exit\\n');
    }, { timeoutMs: 8000, staleMs: 2000, waitMs: 10 });
  `);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-open-'));
  const lock = path.join(dir, 'y.lock');
  fs.writeFileSync(lock, `${process.pid} fresh\n`); // fresh, never goes stale within the timeout
  let ranWith = 'never';
  withFileLock(lock, (held) => { ranWith = held; }, { timeoutMs: 300, staleMs: 60 * 60 * 1000, waitMs: 20 });
  assert.strictEqual(ranWith, false, 'work must still run — blocking forever is worse than the race');
  assert.strictEqual(fs.existsSync(lock), true, "someone else's lock must not be deleted");
  fs.rmSync(dir, { recursive: true, force: true });
});

test('withFileLock releases the lock even when the work throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-throw-'));
  const lock = path.join(dir, 'z.lock');
  assert.throws(() => withFileLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.strictEqual(fs.existsSync(lock), false, 'a thrown error must not leave the lock behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file-lock is requireable from a child process', () => {
  const out = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(LIB)}); console.log('ok')`], { encoding: 'utf8' });
  assert.match(out, /ok/);
});
