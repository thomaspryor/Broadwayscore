import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('./lib/dispatch-watchdog-core.js');
const { isLiveBoardTaskId } = require('./lib/task-id-namespace.js');

// BRO-3437: board-targeting-audit.js found `watchdog-park` at 100% retired-
// Notion ids. executeSweep() (dispatch-watchdog.js) writes a watchdog-park row
// for every item in plan.toPark, plan.jobBlocked, plan.noLaunchPark, and for a
// structural refusal inside plan.toDispatch. This test asserts the class, not
// one loop: over a ledger that puts a retired-board id AND a live-board id
// through every one of those sources, no park-producing list may name a
// retired id, and each live id must still land in its list (so the assertion
// cannot pass by everything being dropped).

const NOW = Date.parse('2026-09-21T15:00:00Z');
const T = (m) => new Date(NOW - m * 60000).toISOString();
const LIVE_TITLES = new Map([['workspace:1', '🤖 Data·x']]);

const RETIRED = { dead: '1864', blocked: '1896', claim: '1889', backlog: '1900' };
const LIVE = {
  dead: 'linear:BRO-701', blocked: 'linear:BRO-702', claim: 'linear:BRO-703', backlog: 'linear:BRO-704',
};

function mkTask(id, status, withPriority) {
  const tag = id.startsWith('linear:') ? `[linear:${id.slice(7)}]` : `[notion:abc-${id}]`;
  return [id, {
    id, subject: `Fix thing ${id}`, status,
    description: `${tag} ${withPriority ? 'P1 Now' : 'P2 Later'} · Backlog · no-category\nbody`,
  }];
}

function deadTwice(id, refA, refB) {
  return [
    { ts: T(300), event: 'launch', taskId: id, subject: 's', workspaceRef: refA },
    { ts: T(290), event: 'dead', taskId: id, workspaceRef: refA },
    { ts: T(280), event: 'launch', taskId: id, subject: 's', workspaceRef: refB },
    { ts: T(270), event: 'dead', taskId: id, workspaceRef: refB },
  ];
}

function buildPlan() {
  const entries = [
    ...deadTwice(RETIRED.dead, 'workspace:10', 'workspace:11'),
    ...deadTwice(LIVE.dead, 'workspace:12', 'workspace:13'),
    { ts: T(60), event: 'job-blocked', taskId: RETIRED.blocked, jobId: 'r-blocked', reason: 'needs owner' },
    { ts: T(60), event: 'job-blocked', taskId: LIVE.blocked, jobId: 'l-blocked', reason: 'needs owner' },
    { ts: T(60), event: 'watchdog-redispatch', taskId: RETIRED.claim, kind: 'p01-backlog' },
    { ts: T(60), event: 'watchdog-redispatch', taskId: LIVE.claim, kind: 'p01-backlog' },
    // Something launched recently so a lone stuck claim reads as a refused card, not a wedged launcher.
    { ts: T(5), event: 'launch', taskId: 'linear:BRO-999', subject: 's', workspaceRef: 'workspace:1' },
  ];
  const tasks = new Map([
    mkTask(RETIRED.dead, 'in_progress', false), mkTask(LIVE.dead, 'in_progress', false),
    mkTask(RETIRED.blocked, 'in_progress', false), mkTask(LIVE.blocked, 'in_progress', false),
    mkTask(RETIRED.claim, 'pending', true), mkTask(LIVE.claim, 'pending', true),
    mkTask(RETIRED.backlog, 'pending', true), mkTask(LIVE.backlog, 'pending', true),
  ]);
  return core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE_TITLES });
}

const ids = (list) => list.map((x) => x.taskId);

test('BRO-3437: every park-producing plan list names live-board ids only', () => {
  const plan = buildPlan();
  const parkSources = {
    toPark: ids(plan.toPark),
    jobBlocked: ids(plan.jobBlocked),
    noLaunchPark: ids(plan.noLaunchPark),
    awaitingClaim: ids(plan.awaitingClaim),
    retryable: ids(plan.retryable),
    toDispatch: ids(plan.toDispatch),
  };
  for (const [name, list] of Object.entries(parkSources)) {
    const retired = list.filter((id) => !isLiveBoardTaskId(id));
    assert.deepEqual(retired, [], `${name} must never name a retired-board id, got ${JSON.stringify(list)}`);
  }
});

test('BRO-3437: the live-board twin of each park source still parks (assertion above is not vacuous)', () => {
  const plan = buildPlan();
  assert.deepEqual(ids(plan.toPark), [LIVE.dead]);
  assert.deepEqual(ids(plan.jobBlocked), [LIVE.blocked]);
  assert.deepEqual(ids(plan.noLaunchPark), [LIVE.claim]);
  assert.ok(ids(plan.toDispatch).includes(LIVE.backlog), 'live backlog card must still be dispatchable');
});

// Tripwire: planSweep's lists are only safe if every PARK write in executeSweep
// consumes one of them. A fifth `event: WATCHDOG_EVENTS.PARK` append would
// bypass the gates asserted above, so adding one must force a conscious
// decision here (gate its source on isLiveBoardTaskId, then bump this count).
test('BRO-3437: dispatch-watchdog.js has exactly the four known PARK write sites', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('./dispatch-watchdog.js', import.meta.url), 'utf8');
  const writes = src.match(/event:\s*core\.WATCHDOG_EVENTS\.PARK\b/g) || [];
  assert.equal(writes.length, 4,
    'a new PARK writer must take its ids from a planSweep list that is gated on isLiveBoardTaskId (toPark, jobBlocked, noLaunchPark, toDispatch)');
});

// BRO-2412: health() must report unhealthy when the heartbeat is fresh but
// dispatch is not flowing. Drives the REAL health() in-process: HOME points at
// a tmp dir (STATE_DIR/heartbeat), and the ledger, cmux, Linear source and the
// pager are stubbed on their module objects (health() reads them dynamically).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// One tmp HOME for the whole file: dispatch-watchdog.js computes STATE_DIR once,
// at first require, so every runHealth() must reuse the same HOME.
const HEALTH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-health-'));
test.after(() => fs.rmSync(HEALTH_HOME, { recursive: true, force: true }));

async function runHealth({ liveWorkspaces, ledgerRows }) {
  const home = HEALTH_HOME;
  const stateDir = path.join(home, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'dispatch-watchdog.json'),
    JSON.stringify({ ts: new Date().toISOString(), mode: 'sweep', pid: process.pid }));
  const ledgerPath = path.join(home, 'ledger.jsonl');
  fs.writeFileSync(ledgerPath, ledgerRows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const prevHome = process.env.HOME;
  const prevDisabled = process.env.DISPATCH_WATCHDOG_DISABLED;
  process.env.HOME = home;
  delete process.env.DISPATCH_WATCHDOG_DISABLED;
  const wd = require('./dispatch-watchdog.js');
  assert.equal(path.dirname(wd.HEARTBEAT_PATH), stateDir, 'watchdog must be reading the tmp heartbeat');
  const ledger = require('./lib/dispatch-ledger.js');
  const cmuxws = require('./lib/cmux-workspaces.js');
  const source = require('./lib/linear-watchdog-source.js');
  const router = require('./lib/owner-alert-router.js');
  const saved = {
    lp: ledger.LEDGER_PATH, lw: cmuxws.listWorkspaces,
    fl: source.fetchLinearWatchdogTasks, ra: router.routeAlert,
    log: console.log, err: console.error,
  };
  const pages = [];
  ledger.LEDGER_PATH = ledgerPath;
  cmuxws.listWorkspaces = () => liveWorkspaces.map(title => ({ title }));
  source.fetchLinearWatchdogTasks = async () => ({ ok: true, tasks: new Map(), started: new Map(), scanned: 0 });
  router.routeAlert = async (a) => { pages.push(a); };
  console.log = () => {}; console.error = () => {};
  try {
    const code = await wd.health();
    return { code, pages };
  } finally {
    Object.assign(console, { log: saved.log, error: saved.err });
    ledger.LEDGER_PATH = saved.lp; cmuxws.listWorkspaces = saved.lw;
    source.fetchLinearWatchdogTasks = saved.fl; router.routeAlert = saved.ra;
    process.env.HOME = prevHome;
    if (prevDisabled === undefined) delete process.env.DISPATCH_WATCHDOG_DISABLED;
    else process.env.DISPATCH_WATCHDOG_DISABLED = prevDisabled;
  }
}

test('BRO-2412: fresh heartbeat + zero dispatch flow => health() unhealthy and pages', async () => {
  const { code, pages } = await runHealth({ liveWorkspaces: [], ledgerRows: [] });
  assert.equal(code, 1);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].conditionKey, 'dispatch-flow-dead');
});

test('BRO-2412: fresh heartbeat + dispatch flowing (live auto tabs + recent launch) => healthy, no page', async () => {
  const recent = new Date(Date.now() - 5 * 60000).toISOString();
  const { code, pages } = await runHealth({
    liveWorkspaces: ['🤖⚡ Data·a', '🤖⚡ Data·b', '🤖⚡ Data·c'],
    ledgerRows: [{ ts: recent, event: 'launch', taskId: 'linear:BRO-1', subject: 's', workspaceRef: 'workspace:1' }],
  });
  assert.equal(code, 0);
  assert.equal(pages.length, 0);
});

// BRO-3904: a healthy (fresh-heartbeat) dashboard whose code changed on disk
// must be restarted by ensureTab — before this, a fresh heartbeat + live pid
// was always "healthy", so stale code ran for hours. Drives the REAL
// ensureTab() with cmux + ledger stubbed, a tmp HOME (shared HEALTH_HOME) and
// a tmp code tree; the "dashboard" is an orphaned sleeper process (not our
// child, so it is reaped like the real one is).
import { spawnSync } from 'node:child_process';
const sc = require('./lib/watchdog-stale-code.js');

// BRO-5412: `& echo $!` hands back the pid the instant bash forks, before
// node has exec'd or installed its SIGTERM handler. ensureTab only signals a
// pid whose ps command line names dispatch-watchdog.js, so a sleeper caught
// mid-exec on a loaded CI runner was (correctly) left alone and the
// restart test failed in 35ms (main run 38768498973). Each sleeper now
// writes a ready file once it is running node with its handler installed,
// and the helper waits for it.
function spawnReadySleeper(script, extraArgs = '') {
  const ready = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-sleeper-')), 'ready');
  const r = spawnSync('bash', ['-c',
    `nohup node -e "${script};require('fs').writeFileSync(process.argv[1],'1');setInterval(()=>{},1000)" "${ready}" ${extraArgs} >/dev/null 2>&1 & echo $!`],
  { encoding: 'utf8' });
  const pid = parseInt(r.stdout.trim(), 10);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready)) {
    if (Date.now() >= deadline) throw new Error(`sleeper ${pid} never became ready`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  fs.rmSync(path.dirname(ready), { recursive: true, force: true });
  return pid;
}
function spawnOrphanSleeper() {
  return spawnReadySleeper("process.on('SIGTERM',()=>process.exit(0))", 'dispatch-watchdog.js --dashboard');
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

async function runEnsureTab({ hb }) {
  const stateDir = path.join(HEALTH_HOME, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'dispatch-watchdog.json'), JSON.stringify(hb));
  const prevHome = process.env.HOME;
  const prevDisabled = process.env.DISPATCH_WATCHDOG_DISABLED;
  process.env.HOME = HEALTH_HOME;
  delete process.env.DISPATCH_WATCHDOG_DISABLED;
  const wd = require('./dispatch-watchdog.js');
  const cmuxws = require('./lib/cmux-workspaces.js');
  const ledger = require('./lib/dispatch-ledger.js');
  const saved = { ca: cmuxws.cmuxAvailable, lw: cmuxws.listWorkspaces, cw: cmuxws.closeWorkspace, run: cmuxws.run,
    ae: ledger.appendEntry, log: console.log, err: console.error };
  const calls = { closed: [], runs: [], ledger: [] };
  const title = `${core.WATCHDOG_TAB_PREFIX} ${core.WATCHDOG_TAB_MARKER} — 3 live`;
  cmuxws.cmuxAvailable = () => true;
  cmuxws.listWorkspaces = () => [{ ref: 'workspace:7', title }];
  cmuxws.closeWorkspace = (ref) => { calls.closed.push(ref); };
  cmuxws.run = (args) => { calls.runs.push(args); return 'OK workspace:8'; };
  ledger.appendEntry = (e) => { calls.ledger.push(e); };
  console.log = () => {}; console.error = () => {};
  try {
    const code = wd.ensureTab();
    return { code, calls, hbAfter: JSON.parse(fs.readFileSync(wd.HEARTBEAT_PATH, 'utf8')) };
  } finally {
    Object.assign(console, { log: saved.log, error: saved.err });
    Object.assign(cmuxws, { cmuxAvailable: saved.ca, listWorkspaces: saved.lw, closeWorkspace: saved.cw, run: saved.run });
    ledger.appendEntry = saved.ae;
    process.env.HOME = prevHome;
    if (prevDisabled === undefined) delete process.env.DISPATCH_WATCHDOG_DISABLED;
    else process.env.DISPATCH_WATCHDOG_DISABLED = prevDisabled;
    for (const args of calls.runs) {
      const cmd = args[args.indexOf('--command') + 1] || '';
      const f = cmd.trim().split(/\s+/)[1];
      if (f && f.includes('bsc-watchdog-dashboard-')) fs.rmSync(f, { force: true });
    }
  }
}

function codeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-code-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'dispatch-watchdog.js'), 'v1');
  fs.writeFileSync(path.join(root, 'lib', 'core.js'), 'v1');
  const old = Date.now() / 1000 - 3600;
  for (const f of ['dispatch-watchdog.js', 'lib/core.js']) fs.utimesSync(path.join(root, f), old, old);
  return root;
}

test('BRO-3904: fresh heartbeat + live pid + code changed on disk => ensureTab restarts the dashboard', async () => {
  const root = codeTree();
  const pid = spawnOrphanSleeper();
  try {
    assert.ok(alive(pid), 'sleeper must be running');
    const id = sc.computeCodeIdentity(root, ['dispatch-watchdog.js', 'lib/core.js']);
    fs.writeFileSync(path.join(root, 'lib', 'core.js'), 'v2, the merged fix');
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(path.join(root, 'lib', 'core.js'), old, old);
    const { code, calls, hbAfter } = await runEnsureTab({
      hb: { ts: new Date().toISOString(), mode: 'dashboard', pid, ...sc.heartbeatCodeFields(id, root) },
    });
    assert.equal(code, 0);
    assert.equal(alive(pid), false, 'stale-code dashboard must have been stopped');
    assert.deepEqual(calls.closed, ['workspace:7']);
    assert.equal(calls.runs.filter(a => a[0] === 'new-workspace').length, 1, 'a fresh crowned tab must be created');
    assert.equal(calls.ledger.length, 1);
    assert.equal(calls.ledger[0].reason, 'stale-code');
    assert.equal(hbAfter.mode, 'starting');
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BRO-3904: fresh heartbeat + live pid + code unchanged => ensureTab leaves it alone', async () => {
  const root = codeTree();
  const pid = spawnOrphanSleeper();
  try {
    const id = sc.computeCodeIdentity(root, ['dispatch-watchdog.js', 'lib/core.js']);
    const { code, calls } = await runEnsureTab({
      hb: { ts: new Date().toISOString(), mode: 'dashboard', pid, ...sc.heartbeatCodeFields(id, root) },
    });
    assert.equal(code, 0);
    assert.equal(alive(pid), true);
    assert.deepEqual(calls.closed, []);
    assert.deepEqual(calls.runs.filter(a => a[0] === 'new-workspace'), []);
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BRO-3904: an OLD heartbeat (pid may be recycled) or a pid not running the watchdog is never signalled', async () => {
  const root = codeTree();
  const pid = spawnOrphanSleeper();
  const plain = spawnReadySleeper('void 0');
  try {
    const id = sc.computeCodeIdentity(root, ['dispatch-watchdog.js', 'lib/core.js']);
    fs.writeFileSync(path.join(root, 'lib', 'core.js'), 'v2');
    const old = Date.now() / 1000 - 3600;
    fs.utimesSync(path.join(root, 'lib', 'core.js'), old, old);
    const code = sc.heartbeatCodeFields(id, root);
    const r1 = await runEnsureTab({ hb: { ts: new Date(Date.now() - 3600e3).toISOString(), mode: 'dashboard', pid, ...code } });
    assert.equal(r1.code, 0);
    assert.equal(alive(pid), true, 'old heartbeat + live pid keeps the pre-existing leave-alone rule');
    assert.deepEqual(r1.calls.closed, []);
    const r2 = await runEnsureTab({ hb: { ts: new Date().toISOString(), mode: 'dashboard', pid: plain, ...code } });
    assert.equal(r2.code, 0);
    assert.equal(alive(plain), true, 'a pid that is not running dispatch-watchdog.js must never be killed');
  } finally {
    for (const p of [pid, plain]) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('BRO-3904: the dashboard heartbeat records a code identity covering itself and its libs', () => {
  const prevHome = process.env.HOME;
  process.env.HOME = HEALTH_HOME;
  try {
    const wd = require('./dispatch-watchdog.js');
    const id = wd.refreshCodeBaseline();
    assert.ok('dispatch-watchdog.js' in id.files);
    assert.ok(path.join('lib', 'dispatch-watchdog-core.js') in id.files);
    assert.ok(path.join('lib', 'watchdog-stale-code.js') in id.files);
    assert.ok(!Object.keys(id.files).some(f => f.includes('node_modules')));
    wd.writeHeartbeat({ mode: 'dashboard' });
    const hb = JSON.parse(fs.readFileSync(wd.HEARTBEAT_PATH, 'utf8'));
    assert.equal(hb.codeHash, id.hash);
    assert.equal(hb.codeRoot, path.dirname(new URL('./dispatch-watchdog.js', import.meta.url).pathname));
    // Nothing changed on disk since load: the outside verdict and the
    // in-process self-check both say "current".
    assert.equal(sc.heartbeatCodeVerdict(hb).reason, 'current');
    assert.equal(wd.codeChangedOnDisk(), false);
  } finally { process.env.HOME = prevHome; }
});

// ── BRO-8167: per-job memory cap (watchdog backstop) ────────────────────────
// Drives the REAL memoryCapPass/runLeasePass with a fake process table.
import fsMc from 'node:fs';
import osMc from 'node:os';
import pathMc from 'node:path';
// Lazy: loading the watchdog at module scope would cache it with the real HOME
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
