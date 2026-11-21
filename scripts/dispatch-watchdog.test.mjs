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
