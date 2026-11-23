// BRO-8167: per-job memory cap + memory-pressure admission tests.
// Own file (not dispatch-watchdog.test.mjs): that file's pre-existing health()
// tests read live bot ledgers, so editing it trips the live-data-lane gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// ── BRO-8167: per-job memory cap (watchdog backstop) ────────────────────────
// Drives the REAL memoryCapPass/runLeasePass with a fake process table.
import fsMc from 'node:fs';
import osMc from 'node:os';
import pathMc from 'node:path';
const require = createRequire(import.meta.url);

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
  let clock = Date.now();
  // BRO-8175: passes are a minute apart (the launchd cadence); back-to-back
  // passes inside MIN_STRIKE_GAP_MS deliberately count as one sample.
  const run = (gb) => require('./dispatch-watchdog.js').memoryCapPass({
    now: (clock += 60 * 1000), log: () => {},
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
  assert.ok(Math.abs(r.perJob[0].memGB - 12) < 0.01);
  assert.match(lines[0], /mem=12\.00GB.*OVER/);
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


// ── BRO-8175: the cap must act within minutes, not half an hour ─────────────
// The 2026-11-23 runaways grew ~1 GB/min. Fake clock + fake process table
// drive the REAL runLeasePass at the cadence the tracked launchd plist
// declares, with the cmux dashboard sweep (90s) both dead and alive.
const AGENT_PLIST = new URL('./launchd/com.broadwayscore.job-memory-cap.plist', import.meta.url);
function plistStartIntervalSec(url) {
  const m = fsMc.readFileSync(url, 'utf8').match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  assert.ok(m, 'plist declares a StartInterval');
  return +m[1];
}
function plistArgs(url) {
  const xml = fsMc.readFileSync(url, 'utf8');
  const arr = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
  return [...arr.matchAll(/<string>([^<]*)<\/string>/g)].map(x => x[1]).join(' ');
}
const CROSS_MS = 180 * 1000; // 5 GB at t=0, +1 GB/min => crosses 8 GB at 180s
const memGBAt = (t) => 5 + t / 60000;
// Returns ms from crossing the cap to the tree being SIGKILL-eligible (kill
// call + KILL_GRACE_MS), and the number of kills.
async function simulate({ agentIntervalMs, agentPhaseMs, dashPhaseMs = null }) {
  const dir = fsMc.mkdtempSync(pathMc.join(osMc.tmpdir(), 'memcap-clock-'));
  const statePath = pathMc.join(dir, 's.json');
  const ticks = [];
  for (let t = agentPhaseMs; t <= 3600e3; t += agentIntervalMs) ticks.push(t);
  if (dashPhaseMs !== null) for (let t = dashPhaseMs; t <= 3600e3; t += 90e3) ticks.push(t);
  ticks.sort((a, b) => a - b);
  const base = Date.parse('2026-11-23T12:00:00Z');
  const kills = [];
  for (const t of ticks) {
    if (kills.length) break; // tree is gone
    await mcLib.runLeasePass({
      jobs: [{ key: 'job-r', pid: 100, taskId: 'linear:BRO-r', jobId: 'job-r' }],
      rows: [{ pid: 100, ppid: 1, pgid: 100, rssKB: Math.round(memGBAt(t) * GBKB) }],
      statePath, capGB: 8, now: base + t, log: () => {},
      ledger: { JOB_EVENTS: { FAILED: 'job-failed' }, appendEntry() {} },
      killFn: async () => { kills.push(t); },
    });
  }
  fsMc.rmSync(dir, { recursive: true, force: true });
  return { lagMs: kills.length ? kills[0] + mcLib.KILL_GRACE_MS - CROSS_MS : Infinity, kills: kills.length };
}

test('BRO-8175: launchd agent runs the memory-only pass (not --health) at <= 60s', () => {
  assert.ok(plistStartIntervalSec(AGENT_PLIST) <= 60);
  const args = plistArgs(AGENT_PLIST);
  assert.match(args, /dispatch-watchdog\.js --memory-cap$/);
  assert.doesNotMatch(args, /--health|--sweep/);
});

test('BRO-8175: a job over the cap is stopped within 3 minutes of crossing it (agent alone, every phase)', async () => {
  const intervalMs = plistStartIntervalSec(AGENT_PLIST) * 1000;
  let worst = 0;
  for (let phase = 0; phase < intervalMs; phase += 5000) {
    const r = await simulate({ agentIntervalMs: intervalMs, agentPhaseMs: phase });
    assert.equal(r.kills, 1);
    worst = Math.max(worst, r.lagMs);
  }
  assert.ok(worst <= 180e3, `worst-case crossing->stop ${worst / 1000}s must be <= 180s`);
  assert.ok(worst <= 2 * intervalMs + mcLib.KILL_GRACE_MS, `worst ${worst / 1000}s`);
});

test('BRO-8175: with the 90s dashboard sweep also running, still <= 3 min and exactly one kill', async () => {
  const intervalMs = plistStartIntervalSec(AGENT_PLIST) * 1000;
  let worst = 0;
  for (let a = 0; a < intervalMs; a += 7000) {
    for (let d = 0; d < 90e3; d += 13000) {
      const r = await simulate({ agentIntervalMs: intervalMs, agentPhaseMs: a, dashPhaseMs: d });
      assert.equal(r.kills, 1);
      worst = Math.max(worst, r.lagMs);
    }
  }
  assert.ok(worst <= 180e3, `worst ${worst / 1000}s`);
});

test('BRO-8175: two over-cap passes inside MIN_STRIKE_GAP_MS are one strike, not a kill', async () => {
  const dir = fsMc.mkdtempSync(pathMc.join(osMc.tmpdir(), 'memcap-gap-'));
  const statePath = pathMc.join(dir, 's.json');
  const killed = [];
  const pass = (now) => mcLib.runLeasePass({ jobs: [{ key: 'j', pid: 100, taskId: 't', jobId: 'j' }], rows: mcRows(4), statePath, capGB: 8, now, log: () => {}, ledger: { JOB_EVENTS: { FAILED: 'job-failed' }, appendEntry() {} }, killFn: async (p) => killed.push(p) });
  const t0 = Date.now();
  await pass(t0);
  const second = await pass(t0 + 1000);
  assert.equal(second.killed.length, 0);
  assert.equal(second.perJob[0].strikes, 1);
  const third = await pass(t0 + mcLib.MIN_STRIKE_GAP_MS);
  assert.equal(third.killed.length, 1, 'a strike spaced >= MIN_STRIKE_GAP_MS from the first one kills');
});

test('BRO-8175: pre-BRO-8175 state file (no strikeAt) still reads its strikes', () => {
  const dir = fsMc.mkdtempSync(pathMc.join(osMc.tmpdir(), 'memcap-old-'));
  const statePath = pathMc.join(dir, 's.json');
  const now = Date.now();
  fsMc.writeFileSync(statePath, JSON.stringify({ ts: new Date(now - 60e3).toISOString(), strikes: { a: 1 } }));
  assert.deepEqual(mcLib.readState(statePath, now), { strikes: { a: 1 }, strikeAt: { a: now - 60e3 } });
});

test('BRO-8175: pass lock — a live holder skips, a dead holder is reclaimed', async () => {
  const dir = fsMc.mkdtempSync(pathMc.join(osMc.tmpdir(), 'memcap-lock-'));
  const statePath = pathMc.join(dir, 's.json');
  const lockDir = `${statePath}.lock`;
  fsMc.mkdirSync(lockDir); fsMc.writeFileSync(pathMc.join(lockDir, 'pid'), String(process.ppid)); // alive
  const args = { jobs: [{ key: 'j', pid: 100, taskId: 't' }], rows: mcRows(1), statePath, capGB: 8, log: () => {}, ledger: {} };
  assert.equal((await mcLib.runLeasePass(args)).skipped, 'locked');
  fsMc.writeFileSync(pathMc.join(lockDir, 'pid'), '999999'); // dead pid
  const r = await mcLib.runLeasePass(args);
  assert.equal(r.skipped, undefined);
  assert.equal(r.perJob.length, 1);
  assert.equal(fsMc.existsSync(lockDir), false, 'lock released after the pass');
  assert.ok(mcLib.stateAgeMs(statePath) < 5000, 'state ts written every pass (liveness)');
});

// Real `footprint -f bytes --noCategories -p 5182 -p 18732 -p 99999` output (2026-11-23).
const FP_SAMPLE = `======================================================================
node [5182]: 64-bit    Footprint: 142344584 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 142377352 B
    phys_footprint_peak: 228656600 B

======================================================================
node [18732]: 64-bit    Footprint: 39852008 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 39884776 B
    phys_footprint_peak: 47060800 B

======================================================================
Summary Footprint: 182196592 B
======================================================================
`;

test('BRO-8175: footprint parser keys on [pid] headers, prefers phys_footprint, ignores Summary', () => {
  const m = mcLib.parseFootprintOutput(FP_SAMPLE);
  assert.deepEqual([...m.entries()], [[5182, 142377352], [18732, 39884776]]);
  assert.equal(m.has(99999), false);
  assert.equal(mcLib.parseFootprintOutput('').size, 0);
});

test('BRO-8175: sampleJobRows charges max(RSS, footprint) and falls back to RSS when footprint fails', () => {
  const ps = () => '  100     1   100  1048576\n  101   100   100  1048576\n  200     1   200 41943040\n';
  // footprint says pid 100 is really 6 GB (compressed pages RSS misses); 101 unknown
  const fp = (bin, args) => { assert.equal(bin, '/usr/bin/footprint'); assert.ok(!args.includes('200'), 'only tree pids are sampled'); return `x [100]: 64-bit    Footprint: ${6 * 1024 ** 3} B (16384 bytes per page)\n`; };
  const rows = mcLib.sampleJobRows([100], { psExec: ps, fpExec: fp });
  const r = mcLib.evaluatePass({ jobs: [{ key: 'k', pid: 100 }], rows, capGB: 8 });
  assert.ok(Math.abs(r.perJob[0].memGB - 7) < 0.01, `6GB footprint + 1GB RSS = 7GB, got ${r.perJob[0].memGB}`);
  const failing = () => { const e = new Error('timeout'); e.stdout = ''; throw e; };
  const rows2 = mcLib.sampleJobRows([100], { psExec: ps, fpExec: failing });
  assert.ok(Math.abs(mcLib.evaluatePass({ jobs: [{ key: 'k', pid: 100 }], rows: rows2, capGB: 8 }).perJob[0].memGB - 2) < 0.01);
  assert.equal(mcLib.sampleJobRows([100], { psExec: () => { throw new Error('no ps'); } }), null);
});

test('BRO-8175: --memory-cap is handled before the dispatch kill switch early-return', () => {
  const src = fsMc.readFileSync(new URL('./dispatch-watchdog.js', import.meta.url), 'utf8');
  const main = src.indexOf('async function main()');
  const mc = src.indexOf("argv.includes('--memory-cap')", main);
  const off = src.indexOf('watchdogOff() && !argv', main);
  assert.ok(main > 0 && mc > main && off > mc, '--memory-cap must short-circuit before watchdogOff()');
});

test('BRO-8175: --health pages when the 60s agent state is stale or missing, not when fresh', () => {
  const { checkMemoryCapLiveness, MEMORY_CAP_STALE_MS } = require('./dispatch-watchdog.js');
  const dir = fsMc.mkdtempSync(pathMc.join(osMc.tmpdir(), 'memcap-live-'));
  const statePath = pathMc.join(dir, 's.json');
  const pages = [];
  const page = (p) => pages.push(p);
  assert.equal(checkMemoryCapLiveness({ statePath, page, env: {} }).stale, true, 'missing state = stale');
  const now = Date.now();
  fsMc.writeFileSync(statePath, JSON.stringify({ ts: new Date(now - 60e3).toISOString(), strikes: {} }));
  assert.equal(checkMemoryCapLiveness({ statePath, now, page, env: {} }).stale, false);
  assert.equal(checkMemoryCapLiveness({ statePath, now: now + MEMORY_CAP_STALE_MS + 1, page, env: {} }).stale, true);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].conditionKey, 'job-memory-cap-agent-stale');
  assert.equal(checkMemoryCapLiveness({ statePath, page, env: { BSC_JOB_MEMORY_CAP_OFF: '1' } }).skipped, 'disabled');
});
