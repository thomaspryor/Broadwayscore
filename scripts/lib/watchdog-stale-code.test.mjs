import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sc = require('./watchdog-stale-code.js');

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-stale-code-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const OLD = Date.now() / 1000 - 3600; // seconds, for utimesSync

test('selectWatchedFiles keeps only scripts/ files, never node_modules', () => {
  const dir = '/r/scripts';
  const got = sc.selectWatchedFiles([
    '/r/scripts/dispatch-watchdog.js', '/r/scripts/lib/a.js', '/r/node_modules/x/i.js',
    '/r/scripts/node_modules/y.js', '/elsewhere/z.js', '/r/scripts/lib/a.js',
  ], dir);
  assert.deepEqual(got, ['dispatch-watchdog.js', path.join('lib', 'a.js')]);
});

test('computeCodeIdentity is content-based: touching mtime does not change the hash, editing does', () => {
  const root = tmpTree({ 'a.js': 'one', 'lib/b.js': 'two' });
  try {
    const a = sc.computeCodeIdentity(root, ['a.js', 'lib/b.js']);
    fs.utimesSync(path.join(root, 'a.js'), OLD, OLD);
    assert.equal(sc.computeCodeIdentity(root, ['a.js', 'lib/b.js']).hash, a.hash);
    fs.writeFileSync(path.join(root, 'lib/b.js'), 'two-fixed');
    const c = sc.computeCodeIdentity(root, ['a.js', 'lib/b.js']);
    assert.notEqual(c.hash, a.hash);
    assert.deepEqual(sc.changedFiles(a.files, c.files), ['lib/b.js']);
    fs.rmSync(path.join(root, 'a.js'));
    const d = sc.computeCodeIdentity(root, ['a.js', 'lib/b.js']);
    assert.equal(d.files['a.js'], 'missing', 'a deleted file is a change');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('combineHashes is order-independent and matches computeCodeIdentity', () => {
  const root = tmpTree({ 'a.js': '1', 'b.js': '2' });
  try {
    const id = sc.computeCodeIdentity(root, ['b.js', 'a.js']);
    const reversed = Object.fromEntries(Object.entries(id.files).reverse());
    assert.equal(sc.combineHashes(reversed), id.hash);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('decideSelfRestart: needs the same changed hash on two consecutive ticks', () => {
  assert.equal(sc.decideSelfRestart({ startupHash: 'A', currentHash: 'A' }).action, 'none');
  const t1 = sc.decideSelfRestart({ startupHash: 'A', currentHash: 'B' });
  assert.deepEqual(t1, { action: 'pending', pendingHash: 'B' });
  // still changing (checkout mid-write) → stays pending on the newer hash
  const t2 = sc.decideSelfRestart({ startupHash: 'A', currentHash: 'C', pendingHash: t1.pendingHash });
  assert.deepEqual(t2, { action: 'pending', pendingHash: 'C' });
  const t3 = sc.decideSelfRestart({ startupHash: 'A', currentHash: 'C', pendingHash: t2.pendingHash });
  assert.equal(t3.action, 'restart');
  // reverted back to startup code → pending cleared
  assert.deepEqual(sc.decideSelfRestart({ startupHash: 'A', currentHash: 'A', pendingHash: 'C' }), { action: 'none', pendingHash: null });
});

test('heartbeatCodeVerdict: matching identity is current; changed code past grace is stale', () => {
  const root = tmpTree({ 'w.js': 'v1', 'lib/l.js': 'v1' });
  try {
    const id = sc.computeCodeIdentity(root, ['w.js', 'lib/l.js']);
    const hb = { mode: 'dashboard', pid: 1, ...sc.heartbeatCodeFields(id, root) };
    assert.deepEqual(sc.heartbeatCodeVerdict(hb), { stale: false, reason: 'current', changed: [] });

    fs.writeFileSync(path.join(root, 'lib/l.js'), 'v2');
    // Just changed: the dashboard gets its own self-restart window first.
    const fresh = sc.heartbeatCodeVerdict(hb);
    assert.equal(fresh.stale, false);
    assert.equal(fresh.reason, 'changed-within-grace');

    fs.utimesSync(path.join(root, 'lib/l.js'), OLD, OLD);
    fs.utimesSync(path.join(root, 'w.js'), OLD, OLD);
    const v = sc.heartbeatCodeVerdict(hb);
    assert.equal(v.stale, true);
    assert.equal(v.reason, 'code-changed');
    assert.deepEqual(v.changed, ['lib/l.js']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('heartbeatCodeVerdict: legacy dashboard (no identity) is stale; starting/sweep stamps are not', () => {
  assert.equal(sc.heartbeatCodeVerdict({ mode: 'dashboard', pid: 1 }).stale, true);
  assert.equal(sc.heartbeatCodeVerdict({ mode: 'dashboard-error', pid: 1 }).stale, true);
  assert.equal(sc.heartbeatCodeVerdict({ mode: 'starting', pid: 1 }).stale, false);
  assert.equal(sc.heartbeatCodeVerdict({ mode: 'sweep', pid: 1 }).stale, false);
  assert.equal(sc.heartbeatCodeVerdict(null).stale, false);
});

test('dashboardLauncherScript relaunches on RESTART_EXIT_CODE only', () => {
  const s = sc.dashboardLauncherScript('/repo/scripts/dispatch-watchdog.js');
  assert.match(s, /^#!\/bin\/bash/);
  assert.match(s, /while :; do/);
  assert.match(s, /node \/repo\/scripts\/dispatch-watchdog\.js --dashboard/);
  assert.ok(s.includes('WATCHDOG_LAUNCHER=1 node '), 'the dashboard only self-restarts (exit 75) under this loop');
  assert.ok(s.includes(`-eq ${sc.RESTART_EXIT_CODE} ] || exit`));
  assert.ok(!/\bexec node\b/.test(s), 'exec would replace bash and lose the relaunch loop');
});

test('dashboardLauncherScript actually loops on 75 and stops otherwise', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-launcher-'));
  try {
    // A fake "dashboard": exits 75 twice, then 0. Counts runs in a file.
    const fake = path.join(dir, 'fake.js');
    const counter = path.join(dir, 'n');
    fs.writeFileSync(fake, `const fs=require('fs');const p=${JSON.stringify(counter)};` +
      `const n=(fs.existsSync(p)?+fs.readFileSync(p,'utf8'):0)+1;fs.writeFileSync(p,String(n));process.exit(n<3?${sc.RESTART_EXIT_CODE}:0);`);
    const script = path.join(dir, 'launch.sh');
    fs.writeFileSync(script, sc.dashboardLauncherScript(fake).replace('sleep 2', 'sleep 0'));
    const r = spawnSync('bash', [script], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(fs.readFileSync(counter, 'utf8'), '3');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
