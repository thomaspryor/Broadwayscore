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
