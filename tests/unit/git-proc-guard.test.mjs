// BRO-7458: orphaned git index-pack chains and their multi-GB temp packs.
// require()s the real module (rule 15). No root needed; live /proc reads touch /proc/self only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const G = require('../../scripts/lib/git-proc-guard.js');

const REPO = '/srv/repo';
const COMMON = `${REPO}/.git`;
const PACK = `${COMMON}/objects/pack`;

const proc = (pid, ppid, cmdline, extra = {}) => ({
  pid, ppid, cmdline, fdTargets: [], cwd: REPO, readable: true, gitLooking: /^git/.test(path.basename(cmdline[0] || '')), state: 'S', nspid: [pid], ageMs: 60_000, ...extra,
});
const indexPack = (pid, ppid, extra) => proc(pid, ppid, ['/usr/lib/git-core/git', 'index-pack', '--stdin', '--fix-thin', '--keep=fetch-pack 1 on vm'], { fdTargets: [`${PACK}/tmp_pack_abc`], ...extra });
const fetch = (pid, ppid, extra) => proc(pid, ppid, ['git', '-c', 'core.hooksPath=/dev/null', 'fetch', '-q', 'origin', 'main'], { fdTargets: [`${COMMON}/FETCH_HEAD`], ...extra });
const node = (pid, ppid) => proc(pid, ppid, ['node', 'scripts/codex/daily-runner.js'], { gitLooking: false });

test('gitSubcommand skips value-taking global options', () => {
  assert.equal(G.gitSubcommand(['-c', 'core.hooksPath=/dev/null', 'fetch']), 'fetch');
  assert.equal(G.gitSubcommand(['-C', REPO, 'fetch', 'origin']), 'fetch');
  assert.equal(G.gitSubcommand(['--git-dir', '/x/.git', '--work-tree', '/x', 'pull']), 'pull');
  assert.equal(G.gitSubcommand(['--git-dir=/x/.git', '--no-pager', 'log']), 'log');
  assert.equal(G.gitSubcommand(['-c', 'gc.auto=0', 'fetch', '-q', 'origin', 'main']), 'fetch');
  assert.equal(G.gitSubcommand(['--version']), null);
});

test('isNetworkGit: fetch/pull/clone only (push and ls-remote deliberately out)', () => {
  assert.equal(G.isNetworkGit(['-c', 'core.hooksPath=/dev/null', 'fetch']), true);
  assert.equal(G.isNetworkGit(['-C', REPO, 'clone', 'u', 'd']), true);
  assert.equal(G.isNetworkGit(['pull', '--rebase']), true);
  assert.equal(G.isNetworkGit(['push', 'origin', 'x']), false);
  assert.equal(G.isNetworkGit(['ls-remote', 'origin']), false);
  assert.equal(G.isNetworkGit(['-C', 'fetch', 'status']), false); // 'fetch' is -C's value here
});

test('stranded index-pack under pid 1 is an orphan chain', () => {
  const r = G.findOrphanGitChains([indexPack(10629, 1)], { gitCommonDir: COMMON });
  assert.deepEqual(r.chains.map((c) => c.pids), [[10629]]);
});

test('index-pack under a live top-level fetch is not killed', () => {
  const recs = [node(100, 50), fetch(101, 100), indexPack(102, 101)];
  const r = G.findOrphanGitChains(recs, { gitCommonDir: COMMON });
  assert.equal(r.chains.length, 0);
});

test('stranded ppid-1 fetch chain: old one is killed whole, young one is not', () => {
  const old = [fetch(200, 1, { ageMs: G.ORPHAN_NETWORK_GIT_AGE_MS + 1 }), proc(201, 200, ['git-remote-https', 'origin', 'https://x']), indexPack(202, 200)];
  const r = G.findOrphanGitChains(old, { gitCommonDir: COMMON });
  assert.equal(r.chains.length, 1);
  assert.deepEqual(r.chains[0].pids.sort(), [200, 201, 202]);
  const young = [fetch(200, 1, { ageMs: 5 * 60_000 }), indexPack(202, 200)];
  assert.equal(G.findOrphanGitChains(young, { gitCommonDir: COMMON }).chains.length, 0);
});

test('nested pid namespace is skipped', () => {
  const r = G.findOrphanGitChains([indexPack(300, 1, { nspid: [300, 7] })], { gitCommonDir: COMMON });
  assert.equal(r.chains.length, 0);
  assert.equal(r.nestedSkipped, 1);
});

test("another repo's orphaned index-pack is not ours", () => {
  const other = indexPack(400, 1, { cwd: '/elsewhere', fdTargets: ['/elsewhere/.git/objects/pack/tmp_pack_x'] });
  assert.equal(G.findOrphanGitChains([other], { gitCommonDir: COMMON }).chains.length, 0);
});

test('a chain topping out at a non-1 non-git parent counts as a subreaper chain, not killed', () => {
  const r = G.findOrphanGitChains([proc(500, 1, ['tini']), indexPack(501, 500)], { gitCommonDir: COMMON });
  assert.equal(r.chains.length, 0);
  assert.equal(r.subreaperChains, 1);
});

test('pidAlive: EPERM is alive, ESRCH dead, zombie dead', () => {
  const err = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  assert.equal(G.pidAlive(9, { kill: err('EPERM'), readState: () => 'S' }), true);
  assert.equal(G.pidAlive(9, { kill: err('ESRCH'), readState: () => 'S' }), false);
  assert.equal(G.pidAlive(9, { kill: () => true, readState: () => 'Z' }), false);
  assert.equal(G.pidAlive(9, { kill: () => true, readState: () => 'S' }), true);
});

test('killChain polls until zombie, never a single signal-0 check', () => {
  let polls = 0;
  const signals = [];
  const kill = (pid, sig) => { if (sig !== 0) signals.push(sig); return true; };
  const readState = () => { polls++; return polls >= 4 ? 'Z' : 'S'; };
  const r = G.killChain([42], { kill, readState, timeoutMs: 2000, pollMs: 5 });
  assert.deepEqual(r.exited, [42]);
  assert.ok(polls >= 4, `polled ${polls} times`);
  assert.deepEqual(signals, ['SIGTERM']);
});

test('killChain escalates to SIGKILL and reports survivors', () => {
  const signals = [];
  const r = G.killChain([43], { kill: (p, s) => { if (s) signals.push(s); return true; }, readState: () => 'S', timeoutMs: 30, pollMs: 5 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(r.survived, [43]);
});

// ---------------------------------------------------------------- pruneGitTempPacks on a temp dir

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-proc-guard-'));
  const common = path.join(root, '.git');
  const pack = path.join(common, 'objects', 'pack');
  fs.mkdirSync(pack, { recursive: true });
  const write = (name, bytes, ageMin) => {
    const f = path.join(pack, name);
    fs.writeFileSync(f, Buffer.alloc(bytes, 1));
    const t = (Date.now() - ageMin * 60_000) / 1000;
    fs.utimesSync(f, t, t);
    return f;
  };
  return { root, common, pack, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A fake world: processes die when they get SIGTERM. */
function world(records) {
  const dead = new Set();
  const signals = [];
  return {
    signals, dead,
    kill: (pid, sig) => {
      if (sig === 0) { if (dead.has(pid) || !records.some((r) => r.pid === pid)) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; } return true; }
      signals.push([pid, sig]); dead.add(pid); return true;
    },
    readState: (pid) => (dead.has(pid) ? null : 'S'),
    scan: () => ({ ok: true, records: records.filter((r) => !dead.has(r.pid)) }),
  };
}

test('unreadable git-looking pid: keep every file, kill nothing', () => {
  const fx = fixtureRepo();
  try {
    fx.write('tmp_pack_old', 10, 120);
    const killed = [];
    const r = G.pruneGitTempPacks({ gitCommonDir: fx.common, kill: (p, s) => killed.push([p, s]), scan: () => ({ ok: false, records: [], why: 'unreadable git-looking pid(s): 77' }) });
    assert.equal(r.ok, false);
    assert.equal(r.reaped.length, 0);
    assert.equal(killed.length, 0);
    assert.ok(fs.existsSync(path.join(fx.pack, 'tmp_pack_old')));
  } finally { fx.cleanup(); }
});

test('readProcRecords fails closed on an unreadable git process (fake /proc, root-proof)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
  try {
    const d = path.join(root, '77');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'comm'), 'git\n');
    fs.writeFileSync(path.join(d, 'stat'), '77 (git) S 1 77 77 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 500 0 0');
    fs.writeFileSync(path.join(d, 'cmdline'), 'git\0index-pack\0--stdin\0');
    fs.writeFileSync(path.join(d, 'status'), 'NSpid:\t77\n');
    fs.symlinkSync('/srv/repo', path.join(d, 'cwd'));
    fs.writeFileSync(path.join(d, 'fd'), 'not a dir'); // readdir -> ENOTDIR: unreadable
    fs.writeFileSync(path.join(root, 'uptime'), '1000.0 1.0\n');
    const r = G.readProcRecords({ procRoot: root });
    assert.equal(r.ok, false);
    assert.match(r.why, /77/);
    // Same entry made readable: parsed cleanly.
    fs.rmSync(path.join(d, 'fd'));
    fs.mkdirSync(path.join(d, 'fd'));
    fs.symlinkSync(`${PACK}/tmp_pack_abc`, path.join(d, 'fd', '4'));
    const ok = G.readProcRecords({ procRoot: root });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.records[0].cmdline, ['git', 'index-pack', '--stdin']);
    assert.equal(ok.records[0].ppid, 1);
    assert.deepEqual(ok.records[0].fdTargets, [`${PACK}/tmp_pack_abc`]);
    assert.equal(G.procRole(ok.records[0]), 'helper');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cannot list /proc: fail closed', () => {
  const r = G.readProcRecords({ procRoot: path.join(os.tmpdir(), 'no-such-proc-dir-bro7458') });
  assert.equal(r.ok, false);
});

test('readProcEntry on /proc/self (live, self only)', { skip: process.platform !== 'linux' }, () => {
  const rec = G.readProcEntry('/proc', 'self', { uptimeMs: null });
  assert.ok(rec && rec.readable);
  assert.equal(rec.ppid, process.ppid);
  assert.ok(rec.cmdline.length > 0);
  assert.ok(rec.fdTargets.length > 0);
});

test('orphan-held young tmp_pack: kill, re-scan, reap; bytes only for unlinked files', () => {
  const fx = fixtureRepo();
  try {
    const f = fx.write('tmp_pack_m9daf5', 1000, 2); // young: only the orphan branch can reap it
    const w = world([indexPack(10629, 1, { fdTargets: [f] })]);
    const r = G.pruneGitTempPacks({ gitCommonDir: fx.common, kill: w.kill, readState: w.readState, scan: w.scan, exitTimeoutMs: 200, pollMs: 5 });
    assert.deepEqual(r.killed, [10629]);
    assert.deepEqual(r.reaped.map((x) => x.name), ['tmp_pack_m9daf5']);
    assert.equal(r.bytes, 1000);
    assert.equal(fs.existsSync(f), false);
  } finally { fx.cleanup(); }
});

test('both reap branches require the re-scan to show no live holder', () => {
  const fx = fixtureRepo();
  try {
    const old = fx.write('tmp_pack_old', 10, 120);
    const young = fx.write('tmp_pack_young', 10, 2);
    // Re-scan finds a NEW live process holding both files (e.g. a fresh fetch reused the name).
    const holder = indexPack(900, 800, { fdTargets: [old, young] });
    let calls = 0;
    const recs = [indexPack(10629, 1, { fdTargets: [young] })];
    const w = world(recs);
    const scan = () => (++calls === 1 ? w.scan() : { ok: true, records: [node(800, 50), fetch(801, 800), holder] });
    const r = G.pruneGitTempPacks({ gitCommonDir: fx.common, kill: w.kill, readState: w.readState, scan, exitTimeoutMs: 200, pollMs: 5 });
    assert.equal(r.reaped.length, 0);
    assert.equal(r.bytes, 0);
    assert.ok(fs.existsSync(old) && fs.existsSync(young));
    // Incomplete re-scan keeps everything too.
    calls = 0;
    const r2 = G.pruneGitTempPacks({ gitCommonDir: fx.common, kill: w.kill, readState: w.readState, scan: () => (++calls === 1 ? { ok: true, records: [] } : { ok: false, records: [], why: 'x' }) });
    assert.equal(r2.reaped.length, 0);
    assert.ok(fs.existsSync(old));
  } finally { fx.cleanup(); }
});

test('old unheld tmp files and dead fetch-pack .keep reap; young unheld and live-owner keep stay', () => {
  const fx = fixtureRepo();
  try {
    fx.write('tmp_pack_old', 10, 120);
    fx.write('tmp_idx_old', 5, 120);
    fx.write('tmp_pack_young', 10, 2);
    fx.write('pack-0123abcd.pack', 99, 120); // real pack: never a candidate
    const deadKeep = fx.write('pack-aaaa.keep', 0, 120);
    fs.writeFileSync(deadKeep, `fetch-pack 999991 on ${os.hostname()}\n`);
    fs.utimesSync(deadKeep, (Date.now() - 7_200_000) / 1000, (Date.now() - 7_200_000) / 1000);
    const liveKeep = fx.write('pack-bbbb.keep', 0, 120);
    fs.writeFileSync(liveKeep, `fetch-pack 555 on ${os.hostname()}\n`);
    fs.utimesSync(liveKeep, (Date.now() - 7_200_000) / 1000, (Date.now() - 7_200_000) / 1000);
    const userKeep = fx.write('pack-cccc.keep', 0, 120); // a person's keep: not fetch-pack's
    const kill = (pid) => { if (pid === 555) return true; const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; };
    const r = G.pruneGitTempPacks({ gitCommonDir: fx.common, kill, readState: () => 'S', scan: () => ({ ok: true, records: [] }) });
    assert.deepEqual(r.reaped.map((x) => x.name).sort(), ['pack-aaaa.keep', 'tmp_idx_old', 'tmp_pack_old']);
    assert.equal(r.bytes, 15 + `fetch-pack 999991 on ${os.hostname()}\n`.length);
    const kept = Object.fromEntries(r.kept.map((k) => [k.name, k.why]));
    assert.match(kept.tmp_pack_young, /young/);
    assert.match(kept['pack-bbbb.keep'], /alive/);
    assert.match(kept['pack-cccc.keep'], /not written by fetch-pack/);
    assert.ok(fs.existsSync(path.join(fx.pack, 'pack-0123abcd.pack')) && fs.existsSync(userKeep));
  } finally { fx.cleanup(); }
});

test('dry run kills nothing and unlinks nothing, but reports the orphan and the file', () => {
  const fx = fixtureRepo();
  try {
    const f = fx.write('tmp_pack_m9daf5', 1000, 2);
    const sent = [];
    const r = G.pruneGitTempPacks({ gitCommonDir: fx.common, dryRun: true, kill: (p, s) => { if (s) sent.push(s); return true; }, readState: () => 'S', scan: () => ({ ok: true, records: [indexPack(10629, 1, { fdTargets: [f] })] }) });
    assert.deepEqual(sent, []);
    assert.deepEqual(r.chains.map((c) => c.top), [10629]);
    assert.deepEqual(r.reaped.map((x) => x.name), ['tmp_pack_m9daf5']);
    assert.equal(r.bytes, 0);
    assert.equal(r.wouldFreeBytes, 1000);
    assert.ok(fs.existsSync(f));
    assert.match(G.summarizePrune(r), /1 orphan chain/);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- real runGit

test('runGit: a timed-out network git has its orphaned helper swept (grandchild dies, child not detached)', { skip: process.platform !== 'linux' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rungit-'));
  let gpid = null;
  try {
    const pidFile = path.join(dir, 'grandchild.pid');
    const argsFile = path.join(dir, 'args.json');
    const fake = path.join(dir, 'git');
    // The fake git starts a helper that looks like git-remote-https (argv0) and hangs; when the
    // timeout kills the fake, the helper is reparented exactly like the real orphaned index-pack.
    fs.writeFileSync(fake, `#!${process.execPath}
const cp = require('child_process');
require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GIT_CONFIG_'))) }));
const g = cp.spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', argv0: 'git-remote-https' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    // The sweep reads only our own grandchild's /proc entry (never pid 1 or other processes).
    const scan = () => {
      const rec = G.readProcEntry('/proc', Number(fs.readFileSync(pidFile, 'utf8')), {});
      return { ok: true, records: rec ? [rec] : [] };
    };
    const t0 = Date.now();
    const r = G.runGit(fake, ['-c', 'core.hooksPath=/dev/null', 'fetch', 'origin'], { timeout: 5000, encoding: 'utf8' }, { scan, pollMs: 20 });
    assert.ok(Date.now() - t0 < 20_000);
    assert.equal(r.timedOut, true);
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    assert.ok(fs.existsSync(pidFile), `fake git never wrote ${pidFile}: the grandchild was not started within the 5 s timeout`);
    gpid = Number(fs.readFileSync(pidFile, 'utf8'));
    // Poll (never one signal-0 check): gone or zombie.
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      alive = G.pidAlive(gpid);
      if (alive) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    assert.equal(alive, false, `grandchild ${gpid} survived (swept: ${JSON.stringify(r.swept)})`);
    assert.ok(r.swept, 'runGit did not sweep after the timeout');
    const seen = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    assert.deepEqual(seen.argv, ['-c', 'core.hooksPath=/dev/null', 'fetch', 'origin'], 'argv is passed through untouched');
    // Appended after whatever GIT_CONFIG_* the environment already carries.
    const n = Number(seen.env.GIT_CONFIG_COUNT);
    assert.equal(seen.env[`GIT_CONFIG_KEY_${n - 2}`], 'http.lowSpeedLimit');
    assert.equal(seen.env[`GIT_CONFIG_VALUE_${n - 2}`], '1');
    assert.equal(seen.env[`GIT_CONFIG_KEY_${n - 1}`], 'http.lowSpeedTime');
  } finally {
    if (gpid) { try { process.kill(gpid, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepOrphanedHelpers: only ppid-1 killable helpers in our group or started after the spawn', () => {
  const sent = [];
  const kill = (p, s) => { if (s) sent.push(p); return true; };
  const recs = [
    indexPack(1, 1, { pgrp: 77, startTicks: 10 }), // ours by group
    indexPack(2, 1, { pgrp: 5, startTicks: 500 }), // started after the spawn
    indexPack(3, 1, { pgrp: 5, startTicks: 10 }), // someone else's, older
    indexPack(4, 99, { pgrp: 77, startTicks: 500 }), // parent still alive
    proc(5, 1, ['git', 'push', 'origin'], { pgrp: 77, startTicks: 500 }), // not a helper
    indexPack(6, 1, { pgrp: 77, startTicks: 500, nspid: [6, 1] }), // nested pid ns
  ];
  const r = G.sweepOrphanedHelpers({ sinceTicks: 100, pgrp: 77, scan: () => ({ ok: true, records: recs }), kill, readState: () => 'Z', readStartTicks: (p) => recs.find((x) => x.pid === p).startTicks, timeoutMs: 50, pollMs: 5 });
  assert.deepEqual(sent.sort(), [1, 2]);
  assert.deepEqual(r.killed.sort(), [1, 2]);
});

test('killChain re-reads start time before signalling and skips a reused pid', () => {
  const sent = [];
  const r = G.killChain([50, 51], { kill: (p, s) => { if (s) sent.push([p, s]); return true; }, readState: () => 'Z', startTicks: new Map([[50, 100], [51, 200]]), readStartTicks: (p) => (p === 50 ? 999 : 200), timeoutMs: 50, pollMs: 5 });
  assert.deepEqual(sent, [[51, 'SIGTERM']]);
  assert.deepEqual(r.exited.sort(), [50, 51]);
});

test('a live git push -> git-remote-https under ppid 1 is never killed', () => {
  const recs = [proc(600, 1, ['git', 'push', 'origin', 'HEAD:refs/heads/x'], { fdTargets: [`${COMMON}/refs`] }), proc(601, 600, ['git-remote-https', 'origin', 'https://x'], { fdTargets: [`${COMMON}/x`] })];
  const r = G.findOrphanGitChains(recs, { gitCommonDir: COMMON });
  assert.equal(r.chains.length, 0);
  // and a ppid-1 non-helper git (e.g. `git gc`) is never a chain top
  assert.equal(G.findOrphanGitChains([proc(602, 1, ['git', 'gc'], { fdTargets: [`${PACK}/tmp_pack_q`] })], { gitCommonDir: COMMON }).chains.length, 0);
});

test('low-speed config: 1 byte/s for 60 s, appended after caller GIT_CONFIG_* entries', () => {
  assert.deepEqual(G.LOW_SPEED_ARGS, ['-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=60']);
  const e = G.withLowSpeedEnv({ PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' });
  assert.equal(e.GIT_CONFIG_COUNT, '3');
  assert.deepEqual([e.GIT_CONFIG_KEY_0, e.GIT_CONFIG_KEY_1, e.GIT_CONFIG_VALUE_1, e.GIT_CONFIG_KEY_2, e.GIT_CONFIG_VALUE_2], ['core.hooksPath', 'http.lowSpeedLimit', '1', 'http.lowSpeedTime', '60']);
  assert.equal(G.withLowSpeedEnv({}).GIT_CONFIG_COUNT, '2');
});

test('runGit: non-network git is a plain spawnSync (no low-speed args, no sweep)', () => {
  const r = G.runGit('git', ['--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /git version/);
  assert.equal(r.timedOut, undefined);
});

test('runGitOrThrow: execFileSync-shaped (returns stdout, throws with status/stderr)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rungit-throw-'));
  try {
    assert.match(G.runGitOrThrow(['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /git version/);
    assert.throws(() => G.runGitOrThrow(['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      (e) => e.status === 128 && /not a git repository/i.test(e.stderr));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GIT_PROC_GUARD_DISABLED=1 turns the sweep and the prune into no-ops (kill switch)', async () => {
  const G = await import('../../scripts/lib/git-proc-guard.js');
  const g = G.default || G;
  const old = process.env.GIT_PROC_GUARD_DISABLED;
  process.env.GIT_PROC_GUARD_DISABLED = '1';
  try {
    let scans = 0;
    const sw = g.sweepOrphanedHelpers({ scan: () => { scans++; return { ok: true, records: [] }; } });
    const pr = g.pruneGitTempPacks({ gitCommonDir: '/nonexistent', scan: () => { scans++; return { ok: true, records: [] }; } });
    assert.equal(sw.disabled, true);
    assert.equal(pr.disabled, true);
    assert.equal(scans, 0);
  } finally { if (old === undefined) delete process.env.GIT_PROC_GUARD_DISABLED; else process.env.GIT_PROC_GUARD_DISABLED = old; }
});
