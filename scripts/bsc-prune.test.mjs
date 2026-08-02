import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { main, USAGE } = require('./bsc-prune.js');

test('USAGE documents --dry-run and --help', () => {
  assert.match(USAGE, /--dry-run/);
  assert.match(USAGE, /--help, -h/);
});

// 2026-07-14 incident class: a bare --help must never fall through to the
// real cmux sweep. Every dep is stubbed to throw (not left as the real
// cmux-workspaces implementation) so this test actually PROVES zero cmux
// calls happen, instead of merely trusting the guard is still correctly
// placed — ship-check catch (2026-07-20): a test that calls real main() with
// real deps would itself perform a live prune if the guard were ever moved.
test('--help / -h return before any cmux call', () => {
  const throwingDeps = {
    cmuxAvailable: () => { throw new Error('cmuxAvailable must not be called for --help'); },
    listWorkspaces: () => { throw new Error('listWorkspaces must not be called for --help'); },
    pruneDone: () => { throw new Error('pruneDone must not be called for --help'); },
    isDoneTitle: () => { throw new Error('isDoneTitle must not be called for --help'); },
    claudeAliveIn: () => { throw new Error('claudeAliveIn must not be called for --help'); },
    terminalSurfaceAliveIn: () => { throw new Error('terminalSurfaceAliveIn must not be called for --help'); },
    readLedgerEntries: () => { throw new Error('readLedgerEntries must not be called for --help'); },
    appendLedgerEntry: () => { throw new Error('appendLedgerEntry must not be called for --help'); },
  };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    assert.doesNotThrow(() => main(['--help'], throwingDeps));
    assert.doesNotThrow(() => main(['-h'], throwingDeps));
  } finally {
    console.log = origLog;
  }
  assert.equal(logged.length, 2);
  assert.match(logged[0], /bsc-prune — close finished Cmux workspaces/);
  assert.match(logged[1], /bsc-prune — close finished Cmux workspaces/);
});

// Task #334: an idle-unmarked workspace that a launch record attributes to a
// task gets (a) labeled in the console report and (b) a 'dead' breadcrumb
// appended to the dispatch ledger — even under --dry-run, since the
// breadcrumb write never touches cmux state (only bsc-conductor's habitual
// `bsc-prune --dry-run` sweep runs this unattended, so dry-run must still
// record it).
test('idle workspace matching a ledger launch: labeled in output + dead breadcrumb appended (incl. under --dry-run)', () => {
  const idleWs = { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' };
  const unrelatedWs = { ref: 'workspace:900', title: 'Some manually opened tab' };
  const appended = [];
  const deps = {
    cmuxAvailable: () => true,
    listWorkspaces: () => [idleWs, unrelatedWs],
    pruneDone: () => ({ closed: [], skipped: [] }),
    isDoneTitle: () => false,
    claudeAliveIn: () => false, // both idle
    terminalSurfaceAliveIn: () => false, // surface registry agrees: truly dead
    readLedgerEntries: () => [
      { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227' },
    ],
    appendLedgerEntry: (e) => appended.push(e),
  };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    main(['--dry-run'], deps);
  } finally {
    console.log = origLog;
  }
  const out = logged.join('\n');
  assert.match(out, /workspace:227.*died mid task #297 "T1-retrieval Sprint 2"/);
  assert.doesNotMatch(out, /workspace:900.*died mid task/);
  assert.equal(appended.length, 1);
  assert.deepEqual(appended[0], { event: 'dead', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227', title: 'T1-retrieval Sprint 2' });
  assert.match(out, /Recorded 1 new dead-dispatch breadcrumb/);
});

// Card #564 adversarial ship-check catch: this idle-unmarked listing feeds
// dispatchLedger.deadBreadcrumbs() the same way checkDeadDispatch does — a
// fourth call site trusting claudeAliveIn alone would reopen the exact
// #559/#564 registry-desync false-negative right next to the three already
// fixed. A workspace where the primary registry says dead but the surface
// registry says alive must NOT get a dead breadcrumb, and must be flagged as
// a registry disagreement.
test('idle-unmarked workspace: no dead breadcrumb when terminalSurfaceAliveIn says alive, even if claudeAliveIn alone said not-alive', () => {
  const desyncedWs = { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' };
  const trulyDeadWs = { ref: 'workspace:229', title: 'Some other task' };
  const appended = [];
  const deps = {
    cmuxAvailable: () => true,
    listWorkspaces: () => [desyncedWs, trulyDeadWs],
    pruneDone: () => ({ closed: [], skipped: [] }),
    isDoneTitle: () => false,
    claudeAliveIn: () => false, // primary registry: both look dead
    terminalSurfaceAliveIn: ref => ref === 'workspace:227', // surface registry disagrees on workspace:227
    readLedgerEntries: () => [
      { event: 'launch', taskId: '297', subject: 'T1-retrieval Sprint 2', workspaceRef: 'workspace:227' },
      { event: 'launch', taskId: '298', subject: 'Some other task', workspaceRef: 'workspace:229' },
    ],
    appendLedgerEntry: (e) => appended.push(e),
  };
  const logged = [];
  const origLog = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    main(['--dry-run'], deps);
  } finally {
    console.log = origLog;
  }
  const out = logged.join('\n');
  const deadBreadcrumbs = appended.filter(e => e.event === 'dead');
  assert.deepEqual(deadBreadcrumbs.map(e => e.workspaceRef), ['workspace:229']);
  assert.match(out, /Registry desync detected: 1 idle-unmarked workspace/);
  assert.match(out, /workspace:227/);
});

test('idle workspace already recorded dead in the ledger: no duplicate breadcrumb', () => {
  const idleWs = { ref: 'workspace:227', title: 'T1-retrieval Sprint 2' };
  const appended = [];
  const deps = {
    cmuxAvailable: () => true,
    listWorkspaces: () => [idleWs],
    pruneDone: () => ({ closed: [], skipped: [] }),
    isDoneTitle: () => false,
    claudeAliveIn: () => false,
    terminalSurfaceAliveIn: () => false,
    readLedgerEntries: () => [
      { event: 'launch', taskId: '297', workspaceRef: 'workspace:227' },
      { event: 'dead', taskId: '297', workspaceRef: 'workspace:227' },
    ],
    appendLedgerEntry: (e) => appended.push(e),
  };
  const origLog = console.log;
  console.log = () => {};
  try { main([], deps); } finally { console.log = origLog; }
  // No DEAD breadcrumb — that is what this test is about. A live (non-dry-run)
  // sweep also journals one 'prune' entry with the counts (S4-T3, the morning
  // email's "Closed N finished tabs" line); it is a different event and does
  // not make the breadcrumb a duplicate.
  assert.deepEqual(appended.filter(e => e.event === 'dead'), []);
  assert.deepEqual(appended.filter(e => e.event === 'prune'), [{ event: 'prune', taskId: 'sweep', closed: 0, skipped: 0 }]);
});

test('a dry-run sweep journals nothing at all', () => {
  const appended = [];
  const deps = {
    cmuxAvailable: () => true,
    listWorkspaces: () => [{ ref: 'workspace:1', title: '✅ done thing' }],
    pruneDone: () => ({ closed: [{ ref: 'workspace:1', title: '✅ done thing' }], skipped: [] }),
    isDoneTitle: t => t.startsWith('✅'),
    claudeAliveIn: () => false,
    readLedgerEntries: () => [],
    appendLedgerEntry: (e) => appended.push(e),
  };
  const origLog = console.log;
  console.log = () => {};
  try { main(['--dry-run'], deps); } finally { console.log = origLog; }
  assert.deepEqual(appended, []);
});

// Belt-and-suspenders: actually run the real CLI. If the --help guard were
// ever removed, this would fall through to `cmuxAvailable()`/`listWorkspaces()`
// (or, in bsc-conductor's case, an interactive `claude` launch) instead of
// exiting immediately — this test would then hang or print sweep output
// instead of usage.
test('node scripts/bsc-prune.js --help prints usage and exits 0 (real process)', () => {
  const out = execFileSync('node', [new URL('./bsc-prune.js', import.meta.url).pathname, '--help'],
    { encoding: 'utf8', timeout: 10_000 });
  assert.match(out, /Usage:/);
  assert.match(out, /--dry-run/);
  assert.doesNotMatch(out, /cmux CLI not found/);
  assert.doesNotMatch(out, /Closed \d/);
});

// ── Owner-close park sweep (task #578) ─────────────────────────────────────
const { sweepVanished } = require('./bsc-prune.js');

function harness(entries, { dryRun = false } = {}) {
  const appended = [], parked = [];
  const deps = {
    readLedgerEntriesFn: () => entries,
    appendLedgerEntryFn: (e) => { const w = { ts: '2026-08-02T15:00:00.000Z', ...e }; appended.push(w); return w; },
    parkCardFn: (v) => parked.push(v),
    dryRun,
  };
  return { appended, parked, deps };
}
const ws = (n) => ({ ref: `workspace:${n}`, title: `t${n}` });
const EPOCH_ENTRY = { event: 'vanish-epoch', taskId: 'epoch', ts: '2026-08-01T00:00:00.000Z' };
const LAUNCHED = { event: 'launch', taskId: '5', subject: 'card', workspaceRef: 'workspace:1', notionId: 'nid', ts: '2026-08-02T10:00:00.000Z' };

test('sweepVanished: first run records the epoch and parks nothing', () => {
  const { appended, parked, deps } = harness([LAUNCHED]);
  sweepVanished({ all: [ws(9)], ...deps });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].event, 'vanish-epoch');
  assert.equal(parked.length, 0, 'the pre-epoch backlog of closed tabs must never mass-park');
});

test('sweepVanished: a closed tab parks the ledger AND the Notion card', () => {
  const { appended, parked, deps } = harness([EPOCH_ENTRY, LAUNCHED]);
  sweepVanished({ all: [ws(9)], ...deps });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].event, 'vanished');
  assert.equal(appended[0].taskId, '5');
  assert.deepEqual(parked.map(p => p.notionId), ['nid']);
});

test('sweepVanished: the ledger park holds even when Notion is unreachable', () => {
  const { appended, deps } = harness([EPOCH_ENTRY, LAUNCHED]);
  deps.parkCardFn = () => { throw new Error('notion 503'); };
  assert.doesNotThrow(() => sweepVanished({ all: [ws(9)], ...deps }));
  assert.equal(appended[0].event, 'vanished', 'ledger is written before Notion, so the park survives');
});

test('sweepVanished: --dry-run writes nothing and parks nothing', () => {
  const { appended, parked, deps } = harness([EPOCH_ENTRY, LAUNCHED], { dryRun: true });
  sweepVanished({ all: [ws(9)], ...deps });
  assert.deepEqual(appended, []);
  assert.deepEqual(parked, []);
});

test('sweepVanished: an empty cmux listing parks nothing (restart/crash guard)', () => {
  const { appended, parked, deps } = harness([EPOCH_ENTRY, LAUNCHED]);
  sweepVanished({ all: [], ...deps });
  assert.deepEqual(appended, []);
  assert.deepEqual(parked, []);
});

test('sweepVanished: re-validates before appending — a task re-dispatched mid-sweep is NOT parked', () => {
  // ship-check P0 (Codex): the candidate list is a snapshot. If bsc-next
  // dispatches this task between the scan and the append, our stale 'vanished'
  // lands AFTER its 'launch' and parkedTasks() (file order) parks a LIVE tab.
  const entries = [EPOCH_ENTRY, LAUNCHED];
  const { appended, parked, deps } = harness(entries);
  let reads = 0;
  deps.readLedgerEntriesFn = () => {
    reads++;
    // First read = the scan. Second read = the pre-append re-validate, by which
    // time bsc-next has relaunched the same workspace ref.
    return reads === 1 ? entries : entries.concat([
      { event: 'launch', taskId: '5', subject: 'card', workspaceRef: 'workspace:1', ts: '2026-08-02T16:00:00.000Z' },
      { event: 'prune-closed', taskId: '5', workspaceRef: 'workspace:1', ts: '2026-08-02T16:00:01.000Z' },
    ]);
  };
  sweepVanished({ all: [ws(9)], ...deps });
  assert.deepEqual(appended, [], 'must not park a task reconciled since the scan');
  assert.deepEqual(parked, []);
});

test('sweepVanished: a failed re-validate read fails closed (no park)', () => {
  const { appended, parked, deps } = harness([EPOCH_ENTRY, LAUNCHED]);
  let reads = 0;
  const first = [EPOCH_ENTRY, LAUNCHED];
  deps.readLedgerEntriesFn = () => { if (++reads === 1) return first; throw new Error('EIO'); };
  assert.doesNotThrow(() => sweepVanished({ all: [ws(9)], ...deps }));
  assert.deepEqual(appended, [], 'a stale/failed read must never park');
  assert.deepEqual(parked, []);
});
