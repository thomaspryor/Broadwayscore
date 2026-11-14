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

for (const abandonedGate of ['none', 'legacy', 'directory', 'recycled-directory']) {
 test(`racing stale-lock breakers (${abandonedGate}): only ONE wins, and a live successor lock is never deleted`, () => {
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
    }, { timeoutMs: 8000, staleMs: 2000, abandonedMs: 15 * 60_000, waitMs: 10 });
  `);
  fs.writeFileSync(lock, '999999 stale\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  if (abandonedGate !== 'none') {
    const gate = `${lock}.steal-gate`;
    const gateOld = new Date(Date.now() - 30 * 60_000);
    if (abandonedGate === 'legacy') {
      fs.writeFileSync(gate, 'abandoned\n');
    } else {
      fs.mkdirSync(gate);
      const owner = path.join(gate, 'old-generation');
      fs.writeFileSync(owner, abandonedGate === 'recycled-directory' ? `${process.pid} old\n` : 'abandoned\n');
      fs.utimesSync(owner, gateOld, gateOld);
    }
    fs.utimesSync(gate, gateOld, gateOld);
  }
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
    assert.strictEqual(lines.length, 12, 'all six racers acquired the lock');
    assert.strictEqual(fs.existsSync(lock), false, 'lock released at the end');
    assert.strictEqual(fs.existsSync(`${lock}.steal-gate`), false, 'no abandoned gate remains');
    assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.includes('.stale-')), [], 'no orphaned steal files');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

}

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


test('BRO-6076: bounded synchronous locks recover recycled PIDs in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-bounded-'));
  try {
    const lock = path.join(dir, 'x.lock');
    fs.writeFileSync(lock, `${process.pid} old\n`);
    const old = new Date(Date.now() - 30 * 60_000);
    fs.utimesSync(lock, old, old);
    const inode = fs.statSync(lock).ino;
    assert.throws(() => withFileLock(lock, held => {
      assert.equal(held, true);
      assert.equal(fs.statSync(lock).ino, inode, 'main lock claimed without an unlink window');
      assert.match(fs.readFileSync(lock, 'utf8'), new RegExp(`^${process.pid} \\d{4}-`));
      throw new Error('body failed');
    }, { abandonedMs: 15 * 60_000, timeoutMs: 100, waitMs: 2 }), /body failed/);
    assert.deepEqual(fs.readdirSync(dir), [], 'recovered main lock and gate released after throw');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const gateKind of ['legacy', 'directory', 'empty-directory']) {
  test(`BRO-6076: abandoned ${gateKind} gate never evicts a fresh main lock`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-fresh-'));
    try {
      const lock = path.join(dir, 'x.lock'), gate = `${lock}.steal-gate`;
      const contents = `${process.pid} fresh\n`;
      fs.writeFileSync(lock, contents);
      const old = new Date(Date.now() - 30 * 60_000);
      if (gateKind === 'legacy') fs.writeFileSync(gate, 'abandoned\n');
      else {
        fs.mkdirSync(gate);
        if (gateKind === 'directory') {
          const marker = path.join(gate, 'old-generation');
          fs.writeFileSync(marker, `${process.pid} recycled\n`);
          fs.utimesSync(marker, old, old);
        }
      }
      fs.utimesSync(gate, old, old);
      let held;
      withFileLock(lock, h => { held = h; }, { abandonedMs: 15 * 60_000, staleMs: gateKind === 'empty-directory' ? Infinity : 60_000, timeoutMs: 40, waitMs: 2 });
      assert.equal(held, false);
      assert.equal(fs.existsSync(gate), false, 'abandoned gate cleared');
      assert.equal(fs.readFileSync(lock, 'utf8'), contents, 'live main lock preserved');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const gateKind of ['legacy', 'directory', 'empty-directory']) {
  test(`BRO-6076: a fresh ${gateKind} gate is never cleared`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-live-gate-'));
    try {
      const lock = path.join(dir, 'x.lock'), gate = `${lock}.steal-gate`;
      if (gateKind === 'legacy') fs.writeFileSync(gate, `${process.pid} fresh\n`);
      else {
        fs.mkdirSync(gate);
        if (gateKind === 'directory') fs.writeFileSync(path.join(gate, 'live-generation'), `${process.pid} fresh\n`);
      }
      let held;
      withFileLock(lock, h => { held = h; }, { abandonedMs: 15 * 60_000, timeoutMs: 40, waitMs: 2 });
      assert.equal(held, false);
      assert.equal(fs.existsSync(gate), true);
      assert.equal(fs.existsSync(lock), false, 'no main lock created through a live gate');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const gateKind of ['legacy', 'directory']) {
  test(`BRO-6076: a delayed ${gateKind} cleaner cannot delete a successor gate`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-cleaner-race-'));
    try {
      const lock = path.join(dir, 'x.lock'), gate = `${lock}.steal-gate`;
      fs.writeFileSync(lock, '999999 old\n');
      const old = new Date(Date.now() - 30 * 60_000);
      fs.utimesSync(lock, old, old);
      let target = gate;
      if (gateKind === 'directory') {
        fs.mkdirSync(gate);
        target = path.join(gate, 'old-generation');
      }
      fs.writeFileSync(target, 'abandoned\n');
      fs.utimesSync(target, old, old);
      const unlink = fs.unlinkSync;
      let swapped = false;
      t.mock.method(fs, 'unlinkSync', file => {
        if (file === target && !swapped) {
          swapped = true;
          // Another cleaner won, released, and a successor acquired the gate
          // after this cleaner's stale check but before its unlink.
          unlink(target);
          if (gateKind === 'directory') fs.rmdirSync(gate);
          fs.mkdirSync(gate);
          fs.writeFileSync(path.join(gate, 'fresh-generation'), `${process.pid} fresh\n`);
        }
        return unlink(file);
      });
      let held;
      withFileLock(lock, h => { held = h; }, { abandonedMs: 15 * 60_000, timeoutMs: 40, waitMs: 2 });
      assert.equal(swapped, true, 'interleaving exercised');
      assert.equal(held, false, 'successor gate prevents a second claim');
      assert.deepEqual(fs.readdirSync(gate), ['fresh-generation']);
      assert.equal(fs.readFileSync(lock, 'utf8'), '999999 old\n');
    } finally {
      t.mock.restoreAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('BRO-6076: removing an empty gate between mkdir and marker creation cannot produce two claimants', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-empty-race-'));
  try {
    const lock = path.join(dir, 'x.lock'), gate = `${lock}.steal-gate`;
    fs.writeFileSync(lock, '999999 old\n');
    const old = new Date(Date.now() - 30 * 60_000);
    fs.utimesSync(lock, old, old);
    const mkdir = fs.mkdirSync;
    let swapped = false;
    t.mock.method(fs, 'mkdirSync', file => {
      const result = mkdir(file);
      if (file === gate && !swapped) {
        swapped = true;
        fs.rmdirSync(gate);
        mkdir(gate);
        fs.writeFileSync(path.join(gate, 'fresh-generation'), `${process.pid} fresh\n`);
      }
      return result;
    });
    let held;
    withFileLock(lock, h => { held = h; }, { abandonedMs: 15 * 60_000, timeoutMs: 40, waitMs: 2 });
    assert.equal(swapped, true, 'interleaving exercised');
    assert.equal(held, false, 'two markers force the late creator to withdraw');
    assert.deepEqual(fs.readdirSync(gate), ['fresh-generation'], 'only our own UUID is removed');
    assert.equal(fs.readFileSync(lock, 'utf8'), '999999 old\n');
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// BRO-6189: timeoutMs smaller than the time to the first check (slow CI
// runner, timeoutMs: 1) used to skip the acquire loop and report a FREE lock
// as busy. At least one attempt must always be made.
test('withFileLock makes one attempt even when the deadline has already passed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-deadline-'));
  const lock = path.join(dir, 'x.lock');
  try {
    const realNow = Date.now;
    let calls = 0;
    // First call (deadline calc) is real; every later call is 1h in the future.
    t.mock.method(Date, 'now', () => (calls++ === 0 ? realNow() : realNow() + 3_600_000));
    let held;
    withFileLock(lock, h => { held = h; }, { timeoutMs: 1, waitMs: 0 });
    t.mock.restoreAll();
    assert.equal(held, true, 'free lock must be acquired despite an expired deadline');
    assert.equal(fs.existsSync(lock), false, 'lock released on exit');
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// BRO-6189 (review follow-up): clearing an abandoned steal gate must not use up
// the guaranteed attempt, or the now-free lock is still reported busy.
test('withFileLock still acquires after clearing an abandoned gate past the deadline', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-gate-deadline-'));
  const lock = path.join(dir, 'x.lock');
  const gate = `${lock}.steal-gate`;
  try {
    fs.mkdirSync(gate);
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(gate, old, old);
    const realNow = Date.now;
    let calls = 0;
    // First Date.now() call MUST be the deadline calc in withFileLock; later calls are 1h ahead.
    t.mock.method(Date, 'now', () => (calls++ === 0 ? realNow() : realNow() + 3_600_000));
    let held;
    withFileLock(lock, h => { held = h; }, { timeoutMs: 1, waitMs: 0 });
    t.mock.restoreAll();
    assert.equal(held, true);
    assert.equal(fs.existsSync(gate), false);
    assert.equal(fs.existsSync(lock), false, 'lock released on exit');
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
