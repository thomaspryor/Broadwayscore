// BRO-8167: per-job memory cap + memory-pressure admission tests.
// Own file (not dispatch-watchdog.test.mjs): that file's pre-existing health()
// tests read live bot ledgers, so editing it trips the live-data-lane gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ── BRO-8167: per-job memory cap (watchdog backstop) ────────────────────────
// Drives the REAL memoryCapPass/runLeasePass with a fake process table.
import fsMc from 'node:fs';
import osMc from 'node:os';
import pathMc from 'node:path';

// before the HOME-sandboxed BRO-2412/3904 tests above get a fresh copy.
const mcLib = require('./lib/job-memory-cap.js');
const GBKB = 1024 * 1024; // 1 GB in KB
// job pid 100 -> child 101 -> grandchild 102; unrelated pid 200 is huge but not ours.
const mcRows = (gbEach) => [
  { pid: 100, ppid: 1, pgid: 100, rssKB: gbEach * GBKB },
  { pid: 101, ppid: 100, pgid: 100, rssKB: gbEach * GBKB },
  { pid: 102, ppid: 101, pgid: 101, rssKB: gbEach * GBKB },
  { pid: 200, ppid: 1, pgid: 200, rssKB: 40 * GBKB },
];
function mcHarness() {
  const dir = fsMc.mkdtempSync(pathMc.join(osMc.tmpdir(), 'memcap-'));
  const rowsLogged = [];
  const killed = [];
  const ledgerFake = { JOB_EVENTS: { FAILED: 'job-failed' }, appendEntry: (e) => rowsLogged.push(e) };
  const jobs = [{ key: 'job-x', pid: 100, taskId: 'linear:BRO-1', jobId: 'job-x' }];
  const run = (gb) => require('./dispatch-watchdog.js').memoryCapPass({
    dryRun: false, rows: mcRows(gb), jobs, ledger: ledgerFake, statePath: pathMc.join(dir, 's.json'), capGB: 8, alert: () => {},
    killFn: async (pids) => { killed.push(pids); },
  });
  return { run, rowsLogged, killed, dir };
}

test('BRO-8167: tree over cap for 2 consecutive passes => kill + job-failed memory-cap row', async () => {
  const h = mcHarness();
  const first = await h.run(4); // 12GB tree > 8GB
  assert.equal(first.killed.length, 0, 'one pass over the cap must not kill');
  assert.equal(h.killed.length, 0);
  const second = await h.run(4);
  assert.equal(second.killed.length, 1);
  assert.deepEqual(h.killed[0].sort(), [100, 101, 102], 'whole tree, not the unrelated 40GB pid');
  assert.equal(h.rowsLogged.length, 1);
  assert.equal(h.rowsLogged[0].event, 'job-failed');
  assert.match(h.rowsLogged[0].reason, /^memory-cap 8GB/);
  assert.equal(h.rowsLogged[0].memoryCapGB, 8);
  assert.equal(h.rowsLogged[0].stage, 'implementer-error', 'must stay in the shared stage vocabulary');
});

test('BRO-8167: a single over-cap pass, then back under, never kills (strikes reset)', async () => {
  const h = mcHarness();
  await h.run(4);
  await h.run(1);  // 3GB: under
  const third = await h.run(4); // over again, but strike counter restarted
  assert.equal(third.killed.length, 0);
  assert.equal(h.killed.length, 0);
  assert.equal(h.rowsLogged.length, 0);
});

test('BRO-8167: a job under the cap is untouched, any number of passes', async () => {
  const h = mcHarness();
  for (let i = 0; i < 4; i++) await h.run(1);
  assert.equal(h.killed.length, 0);
  assert.equal(h.rowsLogged.length, 0);
});

test('BRO-8167: dry-run reports per-job tree RSS and kills nothing, writes no state', async () => {
  const h = mcHarness();
  const lines = [];
  const r = await mcLib.runLeasePass({
    jobs: [{ key: 'job-x', pid: 100, taskId: 'linear:BRO-1', jobId: 'job-x' }], rows: mcRows(4),
    statePath: pathMc.join(h.dir, 'dry.json'), capGB: 8, dryRun: true, ledger: { appendEntry() { throw new Error('no writes in dry-run'); } },
    killFn: async () => { throw new Error('no kills in dry-run'); }, log: (l) => lines.push(l),
  });
  assert.equal(r.perJob.length, 1);
  assert.ok(Math.abs(r.perJob[0].rssGB - 12) < 0.01);
  assert.match(lines[0], /RSS=12\.00GB.*OVER/);
  assert.equal(fsMc.existsSync(pathMc.join(h.dir, 'dry.json')), false);
});

test('BRO-8167: ps unavailable (rows null) fails open', async () => {
  const r = await mcLib.runLeasePass({ jobs: [{ key: 'a', pid: 1, taskId: 't' }], rows: null, statePath: '/nonexistent/x', capGB: 8, ledger: {} });
  assert.equal(r.skipped, 'ps-unavailable');
});

test('BRO-8167: parseCapGB default/override/invalid', () => {
  const warn = () => {};
  assert.equal(mcLib.parseCapGB('', warn), 8);
  assert.equal(mcLib.parseCapGB('12', warn), 12);
  assert.equal(mcLib.parseCapGB('abc', warn), 8);
  assert.equal(mcLib.parseCapGB('0', warn), 8);
});

// ── BRO-8167: memory admission ──────────────────────────────────────────────
test('BRO-8167: runJob refuses launch under kernel memory pressure (ABANDONED, nothing spawned)', async () => {
  const runner = require('./lib/bsc-runner.js');
  const ledger = require('./lib/dispatch-ledger.js');
  const rows = [];
  const saved = ledger.appendEntry;
  ledger.appendEntry = (e) => { rows.push(e); return e; };
  const savedErr = console.error; console.error = () => {};
  const prevFloor = process.env.BSC_DISPATCH_DISK_FLOOR_GB;
  process.env.BSC_DISPATCH_DISK_FLOOR_GB = '0'; // isolate from this machine's disk
  try {
    const res = await runner.runJob({ taskId: 'linear:BRO-mem-test', prompt: 'x', killSwitchEnv: 'NO_SUCH_SWITCH', memoryPressureFn: () => ({ level: 'critical', critical: true, dispatchViable: false }) });
    assert.equal(res.stage, 'memory-pressure');
    assert.equal(res.ok, false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event, 'job-abandoned', 'ABANDONED never burns a dead-attempt strike');
    assert.match(rows[0].reason, /^memory-pressure:/);
  } finally {
    ledger.appendEntry = saved; console.error = savedErr;
    if (prevFloor === undefined) delete process.env.BSC_DISPATCH_DISK_FLOOR_GB; else process.env.BSC_DISPATCH_DISK_FLOOR_GB = prevFloor;
  }
});

test('BRO-8167: shouldRefuseForMemory — normal/warning/unknown pass, critical refuses, env off-switch', () => {
  const { shouldRefuseForMemory } = require('./lib/bsc-runner.js');
  const sp = require('./lib/swap-pressure.js');
  assert.equal(shouldRefuseForMemory(sp.classifyVmPressureLevel(1), {}), false);
  assert.equal(shouldRefuseForMemory(sp.classifyVmPressureLevel(2), {}), false, 'warning is routine load; must not refuse');
  assert.equal(shouldRefuseForMemory(sp.classifyVmPressureLevel(4), {}), true);
  assert.equal(shouldRefuseForMemory(null, {}), false, 'no verdict fails open');
  assert.equal(shouldRefuseForMemory(sp.classifyVmPressureLevel(4), { BSC_DISPATCH_MEM_GUARD: '0' }), false);
});

test('BRO-8167: linear-next and bsc-next both handle the memory-pressure stage without confirming dispatch', () => {
  // These are CLIs (no importable branch), so assert the stage is handled
  // before dispatchConfirmed flips — same shape as the disk-pressure branch.
  for (const f of ['linear-next.js', 'bsc-next.js']) {
    const src = fsMc.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    const mem = src.indexOf("stage === 'memory-pressure'");
    const disk = src.indexOf("stage === 'disk-pressure'");
    const confirmed = src.indexOf('dispatchConfirmed = true', disk);
    assert.ok(mem > 0 && disk > 0 && confirmed > mem, `${f}: memory-pressure branch must precede dispatchConfirmed = true`);
  }
});

test('BRO-8167: claude-cli kills a runaway tree after 2 over-cap samples (stage error + memoryCap field)', async () => {
  const { runClaudeCli } = require('./lib/claude-cli.js');
  const bin = pathMc.join(osMc.tmpdir(), `fake-claude-${process.pid}.sh`);
  fsMc.writeFileSync(bin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const r = await runClaudeCli({
    prompt: 'x', cwd: osMc.tmpdir(), env: { CLAUDE_BIN: bin }, memoryCapGB: 1, memorySampleMs: 50, graceMs: 200,
    // fake RSS: 5GB for whatever pid is the child
    sampleRows: () => (global.__mcPid ? [{ pid: global.__mcPid, ppid: 1, pgid: global.__mcPid, rssKB: 5 * GBKB }] : []),
    onSpawn: (pid) => { global.__mcPid = pid; },
    timeoutMs: 20000,
  });
  fsMc.rmSync(bin, { force: true });
  assert.equal(r.stage, 'implementer-error');
  assert.ok(r.memoryCap, 'memoryCap field present');
  assert.match(r.memoryCap.reason, /^memory-cap 1GB/);
  assert.match(r.errorDetail, /memory-cap/);
});

test('BRO-8167: lease with a recycled/non-claude pid is never treated as a live job (never signalled)', () => {
  const root = fsMc.mkdtempSync(pathMc.join(osMc.tmpdir(), 'leases-'));
  for (const [d, pid] of [['linear:BRO-a', 4242], ['linear:BRO-b', 4343]]) {
    fsMc.mkdirSync(pathMc.join(root, d));
    fsMc.writeFileSync(pathMc.join(root, d, 'lease.json'), JSON.stringify({ pid, jobId: `j-${pid}` }));
  }
  const jobs = mcLib.liveJobsFromLeases(root, { looksLive: (l) => l.pid === 4242 });
  assert.deepEqual(jobs.map(j => j.pid), [4242]);
});

test('BRO-8167: BSC_JOB_MEMORY_CAP_OFF=1 disables the watchdog pass; claude-cli cap is opt-in', async () => {
  assert.equal(mcLib.capDisabled({ BSC_JOB_MEMORY_CAP_OFF: '1' }), true);
  assert.equal(mcLib.capDisabled({}), false);
  process.env.BSC_JOB_MEMORY_CAP_OFF = '1';
  try {
    const r = await mcLib.runLeasePass({ jobs: [{ key: 'a', pid: 100, taskId: 't' }], rows: mcRows(40), statePath: '/nonexistent/x', capGB: 8, ledger: {}, killFn: async () => { throw new Error('must not kill'); } });
    assert.equal(r.skipped, 'disabled');
  } finally { delete process.env.BSC_JOB_MEMORY_CAP_OFF; }
  // opt-in: no memoryCapGB => no sampler => a "huge" fake table never kills
  const { runClaudeCli } = require('./lib/claude-cli.js');
  const bin = pathMc.join(osMc.tmpdir(), `fake-claude-ok-${process.pid}.sh`);
  fsMc.writeFileSync(bin, '#!/bin/sh\nexec sleep 1\n', { mode: 0o755 });
  const r2 = await runClaudeCli({ prompt: 'x', cwd: osMc.tmpdir(), env: { CLAUDE_BIN: bin }, memorySampleMs: 20, sampleRows: () => [{ pid: 1, ppid: 0, pgid: 1, rssKB: 99 * GBKB }], timeoutMs: 20000 });
  fsMc.rmSync(bin, { force: true });
  assert.equal(r2.memoryCap, null);
});

test('BRO-8167: a strike older than 10 min is not "consecutive"', async () => {
  const dir = fsMc.mkdtempSync(pathMc.join(osMc.tmpdir(), 'memcap-age-'));
  const statePath = pathMc.join(dir, 's.json');
  fsMc.writeFileSync(statePath, JSON.stringify({ ts: new Date(Date.now() - 3600e3).toISOString(), strikes: { 'job-x': 1 } }));
  const killed = [];
  const r = await mcLib.runLeasePass({ jobs: [{ key: 'job-x', pid: 100, taskId: 't', jobId: 'job-x' }], rows: mcRows(4), statePath, capGB: 8, ledger: { JOB_EVENTS: { FAILED: 'job-failed' }, appendEntry() {} }, killFn: async (p) => killed.push(p), log: () => {} });
  assert.equal(r.killed.length, 0, 'stale strike must not combine with one fresh over-cap pass');
});
