// review-texts-lock.js (BRO-7171): one machine-wide lock for every writer of
// the local review-texts checkout. Stale = holder pid gone OR pid recycled
// (start time changed); a live holder past the timeout throws.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lock-'));
process.env.REVIEW_TEXTS_LOCK_PATH = path.join(TMP, 'locks', 'review-texts.lock');
const lock = require('./review-texts-lock.js');

const body = (meta) => `${meta.pid} ${JSON.stringify(meta)}\n`;
const children = [];
after(() => { for (const c of children) try { c.kill(); } catch { /* gone */ } });

function liveChild() {
  const c = spawn('sleep', ['60'], { stdio: 'ignore' });
  children.push(c);
  return c;
}
function deadPid() {
  const r = spawnSync('true');
  return r.pid;
}

test('holderAlive: live pid with the recorded start time is alive', () => {
  const meta = { pid: 4242, procStart: 'Sun Nov  8 10:00:00 2026', host: os.hostname(), acquiredAt: new Date().toISOString() };
  assert.equal(lock.holderAlive(body(meta), { alive: () => true, startOf: () => meta.procStart }), true);
});

test('holderAlive: a recycled pid (same number, different start time) is a dead holder', () => {
  const meta = { pid: 4242, procStart: 'Sun Nov  8 10:00:00 2026', host: os.hostname(), acquiredAt: new Date().toISOString() };
  assert.equal(lock.holderAlive(body(meta), { alive: () => true, startOf: () => 'Sun Nov  8 11:30:00 2026' }), false);
});

test('holderAlive: dead pid is dead; other host is alive for 2h only', () => {
  const meta = { pid: 4242, procStart: 'x', host: os.hostname(), acquiredAt: new Date().toISOString() };
  assert.equal(lock.holderAlive(body(meta), { alive: () => false }), false);
  const now = Date.now();
  const remote = { ...meta, host: 'other-mac', acquiredAt: new Date(now - 60 * 60 * 1000).toISOString() };
  assert.equal(lock.holderAlive(body(remote), { now, alive: () => true }), true);
  const old = { ...remote, acquiredAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() };
  assert.equal(lock.holderAlive(body(old), { now, alive: () => true }), false);
  // Another hostname whose pid is dead here: this Mac renamed itself, holder is gone.
  assert.equal(lock.holderAlive(body(remote), { now, alive: () => false }), false);
});

test('runs fn under the lock, writes holder metadata, releases afterwards', () => {
  const out = lock.withReviewTextsLock('test:basic', () => {
    assert.equal(lock.isHeldByMe(), true);
    const h = lock.readHolder();
    assert.equal(h.pid, process.pid);
    assert.equal(h.label, 'test:basic');
    assert.ok(h.procStart, 'start time recorded');
    return 7;
  });
  assert.equal(out, 7);
  assert.equal(lock.isHeldByMe(), false);
  assert.equal(fs.existsSync(lock.lockPath()), false);
});

test('re-entrant within one process (no self-deadlock), released even when fn throws', () => {
  assert.throws(() => lock.withReviewTextsLock('outer', () => {
    lock.withReviewTextsLock('inner', () => { assert.equal(lock.isHeldByMe(), true); });
    throw new Error('boom');
  }), /boom/);
  assert.equal(lock.isHeldByMe(), false);
  assert.equal(fs.existsSync(lock.lockPath()), false);
});

test('a live holder past the timeout THROWS instead of proceeding unlocked', () => {
  const c = liveChild();
  const p = lock.lockPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body({ pid: c.pid, procStart: lock.processStartTime(c.pid), host: os.hostname(), label: 'other', acquiredAt: new Date().toISOString() }));
  let ran = false;
  const t0 = Date.now();
  assert.throws(() => lock.withReviewTextsLock('waiter', () => { ran = true; }, { timeoutMs: 1200 }), (e) => e.code === 'ELOCKTIMEOUT');
  assert.equal(ran, false);
  assert.ok(Date.now() - t0 >= 1000, 'waited for the timeout');
  fs.unlinkSync(p);
});

test('a dead holder is taken over', () => {
  const p = lock.lockPath();
  fs.writeFileSync(p, body({ pid: deadPid(), procStart: 'gone', host: os.hostname(), label: 'crashed', acquiredAt: new Date().toISOString() }));
  let ran = false;
  const t0 = Date.now();
  lock.withReviewTextsLock('taker', () => { ran = true; }, { timeoutMs: 5000 });
  assert.equal(ran, true);
  assert.ok(Date.now() - t0 < 3000, 'taken over as stale, not by waiting out the timeout');
});

test('a recycled pid holder is taken over (pid alive, start time differs)', () => {
  const c = liveChild();
  const p = lock.lockPath();
  fs.writeFileSync(p, body({ pid: c.pid, procStart: 'Thu Jan  1 00:00:00 1970', host: os.hostname(), label: 'old-run', acquiredAt: new Date().toISOString() }));
  let ran = false;
  const t0 = Date.now();
  lock.withReviewTextsLock('taker', () => { ran = true; }, { timeoutMs: 5000 });
  assert.equal(ran, true);
  assert.ok(Date.now() - t0 < 3000, 'taken over as stale, not by waiting out the timeout');
});

test('a just-created EMPTY lock (holder mid-create) is not stolen; an old empty one is', () => {
  const now = Date.now();
  assert.equal(lock.holderAlive('', { now, mtimeMs: now - 50 }), true);
  assert.equal(lock.holderAlive('', { now, mtimeMs: now - 60 * 1000 }), false);
  const p = lock.lockPath();
  fs.writeFileSync(p, '');
  let ran = false;
  assert.throws(() => lock.withReviewTextsLock('thief', () => { ran = true; }, { timeoutMs: 400 }), (e) => e.code === 'ELOCKTIMEOUT');
  assert.equal(ran, false, 'did not steal a lock whose holder had not written its body yet');
  fs.unlinkSync(p);
});

test('a dead local pid stamped with a stale hostname (macOS renames on network change) is taken over', () => {
  const p = lock.lockPath();
  fs.writeFileSync(p, body({ pid: deadPid(), procStart: 'gone', host: 'old-dhcp-name.local', label: 'crashed', acquiredAt: new Date().toISOString() }));
  let ran = false;
  const t0 = Date.now();
  lock.withReviewTextsLock('taker', () => { ran = true; }, { timeoutMs: 3000 });
  assert.equal(ran, true);
  assert.ok(Date.now() - t0 < 2000, 'not blocked for 2h by a hostname change');
});

// BRO-7171: shell sync tools re-exec under `run`; the child (and the node
// helpers it calls) must see the parent's hold as theirs, or the first lock
// call inside the child waits 30 min on its own parent.
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), 'review-texts-lock.js');
const cliEnv = () => { const e = { ...process.env, REVIEW_TEXTS_LOCK_PATH: lock.lockPath() }; delete e.REVIEW_TEXTS_LOCK_TOKEN; return e; };

test('run: the child inherits the hold; exit code passes through; released after', () => {
  const env = cliEnv();
  const inner = `const L = require(${JSON.stringify(CLI)}); const t0 = Date.now();
    L.withReviewTextsLock('nested', () => {}, { timeoutMs: 2000 });
    console.log(JSON.stringify({ held: L.inheritedHold(), ms: Date.now() - t0 }));`;
  const r = spawnSync(process.execPath, [CLI, 'run', '--', process.execPath, '-e', inner], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.held, true);
  assert.ok(out.ms < 1500, `nested lock call inside run waited ${out.ms}ms`);
  assert.equal(spawnSync(process.execPath, [CLI, 'held'], { env }).status, 1, 'not held outside a run');
  assert.equal(spawnSync(process.execPath, [CLI, 'run', '--', 'sh', '-c', 'exit 7'], { env }).status, 7);
  assert.equal(fs.existsSync(lock.lockPath()), false, 'released after run');
});

// Ship-check: a node holder that shells out to a locked tool (sync-review-texts.sh
// calls `held`, else re-execs under `run`) must hand the hold down, not wait 30 min on itself.
test('a child spawned inside withReviewTextsLock sees the hold as its own', () => {
  const env = cliEnv();
  const outer = `const L = require(${JSON.stringify(CLI)}); const { spawnSync } = require('child_process');
    L.withReviewTextsLock('outer', () => {
      const r = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'held'], { env: process.env });
      console.log('HELD_EXIT=' + r.status);
    }, { timeoutMs: 2000 });
    console.log('AFTER=' + (process.env.${'REVIEW_TEXTS_LOCK_TOKEN'} || 'unset'));`;
  const r = spawnSync(process.execPath, ['-e', outer], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /HELD_EXIT=0/);
  assert.match(r.stdout, /AFTER=unset/, 'token cleared after release');
});

test('run: another process (even with a forged token) waits for the hold', () => {
  const env = cliEnv();
  const holder = spawn(process.execPath, [CLI, 'run', '--', 'sleep', '3'], { env, stdio: 'ignore' });
  children.push(holder);
  const t0 = Date.now();
  while (!fs.existsSync(lock.lockPath()) && Date.now() - t0 < 3000) spawnSync('sleep', ['0.1']);
  const probe = `const L = require(${JSON.stringify(CLI)});
    try { L.withReviewTextsLock('other', () => {}, { timeoutMs: 600 }); console.log('RAN'); } catch (e) { console.log(e.code); }`;
  const r = spawnSync(process.execPath, ['-e', probe], { env: { ...env, REVIEW_TEXTS_LOCK_TOKEN: 'forged' }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'ELOCKTIMEOUT');
  assert.equal(spawnSync(process.execPath, [CLI, 'held'], { env: { ...env, REVIEW_TEXTS_LOCK_TOKEN: 'forged' } }).status, 1);
  holder.kill();
});
