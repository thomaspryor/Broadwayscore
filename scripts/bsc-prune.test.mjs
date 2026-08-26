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
    acquireRunLock: () => true, releaseRunLock: () => {},
  };
  const origLog = console.log;
  console.log = () => {};
  try { main([], deps); } finally { console.log = origLog; }
  // No DEAD breadcrumb — that is what this test is about. Since the scheduled
  // auto-prune tick (owner escalation 2026-08-02) a NO-OP sweep (nothing
  // closed or skipped) also journals no 'prune' entry — a 5-min cadence would
  // otherwise write ~288 empty lines/day for zero digest value.
  assert.deepEqual(appended.filter(e => e.event === 'dead'), []);
  assert.deepEqual(appended.filter(e => e.event === 'prune'), []);
});

test('a sweep with activity still journals the prune counts entry (S4-T3 morning-email line)', () => {
  const appended = [];
  const deps = {
    cmuxAvailable: () => true,
    listWorkspaces: () => [],
    pruneDone: () => ({ closed: [{ ref: 'workspace:5', title: '\u2705 \ud83e\udd16 done tab' }], skipped: [] }),
    isDoneTitle: () => false,
    claudeAliveIn: () => false,
    terminalSurfaceAliveIn: () => false,
    readLedgerEntries: () => [],
    appendLedgerEntry: (e) => appended.push(e),
    acquireRunLock: () => true, releaseRunLock: () => {},
  };
  const origLog = console.log;
  console.log = () => {};
  try { main([], deps); } finally { console.log = origLog; }
  assert.deepEqual(appended.filter(e => e.event === 'prune'), [{ event: 'prune', taskId: 'sweep', closed: 1, skipped: 0 }]);
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
    // Fixed clock, well within HISTORICAL_EXCLUSION_GRACE_MS of the fixture
    // epochs below (2026-08-01/02) — sweepVanished's real-clock default
    // would otherwise make these tests drift/fail once wall-clock time
    // outruns the fixtures' grace window (card #801 follow-on catch).
    now: Date.parse('2026-08-02T16:00:00.000Z'),
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

// ── Restart-vs-close disambiguation (task #883) ─────────────────────────────
// LAUNCHED's subject ('card') is deliberately too short (<20 chars) to ever
// title-match — every test ABOVE this point already proves the pre-#883
// behavior is unaffected by the new remap/circuit-breaker code path.
const LONG_SUBJECT = 'Session-system overhaul S0: hook foundations for the reconciler';
const LAUNCHED_LONG = { event: 'launch', taskId: '5', subject: LONG_SUBJECT, workspaceRef: 'workspace:1', notionId: 'nid', ts: '2026-08-02T10:00:00.000Z' };

test('sweepVanished: same session under a new ref (title match) is remapped (both entries), not parked', () => {
  const { appended, parked, deps } = harness([EPOCH_ENTRY, LAUNCHED_LONG]);
  // workspace:1 is gone; workspace:41 has the SAME title under a new ref —
  // the cmux-restart renumbering signature (owner report 2026-08-03).
  sweepVanished({ all: [ws(9), { ref: 'workspace:41', title: `🤖⚡ Data·${LONG_SUBJECT}` }], ...deps });
  assert.equal(appended.length, 2, 'old ref gets a terminal entry AND the new ref gets a launch (ship-check P0: a bare new launch left the old ref open forever)');
  assert.equal(appended[0].event, 'remapped');
  assert.equal(appended[0].workspaceRef, 'workspace:1');
  assert.equal(appended[0].newRef, 'workspace:41');
  assert.equal(appended[1].event, 'launch');
  assert.equal(appended[1].workspaceRef, 'workspace:41');
  assert.equal(appended[1].remapped, true);
  assert.equal(appended[1].previousRef, 'workspace:1');
  assert.deepEqual(parked, [], 'a renumbered session must never be parked');
});

test('sweepVanished: remap carries forward model/verifyCmd from the original launch', () => {
  const armed = { ...LAUNCHED_LONG, model: 'opus', verifyCmd: 'node --test foo.test.mjs', verifyReason: null };
  const { appended, deps } = harness([EPOCH_ENTRY, armed]);
  sweepVanished({ all: [{ ref: 'workspace:41', title: `🤖⚡ Data·${LONG_SUBJECT}` }], ...deps });
  const newLaunch = appended.find(e => e.event === 'launch');
  assert.equal(newLaunch.model, 'opus');
  assert.equal(newLaunch.verifyCmd, 'node --test foo.test.mjs');
});

test('sweepVanished: a remapped ref never re-triggers on the next sweep (no infinite remap spam)', () => {
  // ship-check P0 regression test: without a terminal entry for the OLD ref,
  // vanishedBreadcrumbs kept re-flagging it and findRenumberedWorkspace kept
  // re-matching the same live workspace — one remap line every 5 minutes.
  const { appended, deps } = harness([EPOCH_ENTRY, LAUNCHED_LONG]);
  const all = [{ ref: 'workspace:41', title: `🤖⚡ Data·${LONG_SUBJECT}` }];
  sweepVanished({ all, ...deps });
  assert.equal(appended.length, 2, 'first sweep remaps once');
  const entries2 = [EPOCH_ENTRY, LAUNCHED_LONG, ...appended];
  deps.readLedgerEntriesFn = () => entries2;
  sweepVanished({ all, ...deps });
  assert.equal(appended.length, 2, 'second sweep must not append anything more — workspace:1 is already terminally reconciled');
});

test('sweepVanished: --dry-run reports a remap but writes nothing', () => {
  const { appended, parked, deps } = harness([EPOCH_ENTRY, LAUNCHED_LONG], { dryRun: true });
  sweepVanished({ all: [{ ref: 'workspace:41', title: LONG_SUBJECT }], ...deps });
  assert.deepEqual(appended, []);
  assert.deepEqual(parked, []);
});

test('sweepVanished: mass-renumbering (no title match) withholds the park, records a restart-hold', () => {
  // 3 tracked launches, all 3 vanish in the same sweep with no live title
  // match for any of them — RESTART_MIN_COUNT=3 and 3/3 >= RESTART_FRACTION
  // trips the circuit breaker; nothing should park, but the hold IS recorded
  // (ship-check catch: without it, a genuine mass-close latches forever).
  const entries = [
    EPOCH_ENTRY,
    { event: 'launch', taskId: '1', subject: 'Task one is a long enough subject', workspaceRef: 'workspace:1', ts: '2026-08-02T10:00:00.000Z' },
    { event: 'launch', taskId: '2', subject: 'Task two is a long enough subject', workspaceRef: 'workspace:2', ts: '2026-08-02T10:00:00.000Z' },
    { event: 'launch', taskId: '3', subject: 'Task three is a long enough subject', workspaceRef: 'workspace:3', ts: '2026-08-02T10:00:00.000Z' },
  ];
  const { appended, parked, deps } = harness(entries);
  sweepVanished({ all: [ws(9)], ...deps }); // only an unrelated workspace listed
  assert.equal(appended.length, 1);
  assert.equal(appended[0].event, 'restart-hold');
  assert.deepEqual(appended[0].refs.sort(), ['workspace:1', 'workspace:2', 'workspace:3']);
  assert.deepEqual(parked, []);
});

test('sweepVanished: a still-active restart-hold (same refs, under 15min) keeps withholding without re-appending', () => {
  const entries = [
    EPOCH_ENTRY,
    { event: 'launch', taskId: '1', subject: 'Task one is a long enough subject', workspaceRef: 'workspace:1', ts: '2026-08-02T10:00:00.000Z' },
    { event: 'launch', taskId: '2', subject: 'Task two is a long enough subject', workspaceRef: 'workspace:2', ts: '2026-08-02T10:00:00.000Z' },
    { event: 'launch', taskId: '3', subject: 'Task three is a long enough subject', workspaceRef: 'workspace:3', ts: '2026-08-02T10:00:00.000Z' },
    { event: 'restart-hold', taskId: 'sweep', refs: ['workspace:1', 'workspace:2', 'workspace:3'], ts: new Date(Date.now() - 60_000).toISOString() },
  ];
  const { appended, parked, deps } = harness(entries);
  sweepVanished({ all: [ws(9)], ...deps });
  assert.deepEqual(appended, [], 'an already-recorded, still-fresh hold must not be re-appended every tick');
  assert.deepEqual(parked, []);
});

test('sweepVanished: an expired restart-hold (>15min, same refs) falls through and parks', () => {
  const entries = [
    EPOCH_ENTRY,
    { event: 'launch', taskId: '1', subject: 'Task one is a long enough subject', workspaceRef: 'workspace:1', ts: '2026-08-02T10:00:00.000Z', notionId: 'n1' },
    { event: 'launch', taskId: '2', subject: 'Task two is a long enough subject', workspaceRef: 'workspace:2', ts: '2026-08-02T10:00:00.000Z', notionId: 'n2' },
    { event: 'launch', taskId: '3', subject: 'Task three is a long enough subject', workspaceRef: 'workspace:3', ts: '2026-08-02T10:00:00.000Z', notionId: 'n3' },
    { event: 'restart-hold', taskId: 'sweep', refs: ['workspace:1', 'workspace:2', 'workspace:3'], ts: new Date(Date.now() - 20 * 60_000).toISOString() },
  ];
  const { appended, parked, deps } = harness(entries);
  sweepVanished({ all: [ws(9)], ...deps });
  assert.equal(appended.length, 3, 'a genuine mass-close (never resolved by remap) parks once the hold window expires');
  assert.deepEqual(appended.map(e => e.event), ['vanished', 'vanished', 'vanished']);
  assert.equal(parked.length, 3);
});

test('sweepVanished: a NEW restart incident (different refs) starts its own fresh hold, not inheriting an old expired one', () => {
  const entries = [
    EPOCH_ENTRY,
    { event: 'launch', taskId: '4', subject: 'Task four is a long enough subject', workspaceRef: 'workspace:4', ts: '2026-08-02T10:00:00.000Z' },
    { event: 'launch', taskId: '5', subject: 'Task five is a long enough subject', workspaceRef: 'workspace:5', ts: '2026-08-02T10:00:00.000Z' },
    { event: 'launch', taskId: '6', subject: 'Task six is a long enough subject', workspaceRef: 'workspace:6', ts: '2026-08-02T10:00:00.000Z' },
    // An OLD, unrelated, already-expired hold from a prior (already resolved) incident.
    { event: 'restart-hold', taskId: 'sweep', refs: ['workspace:1', 'workspace:2', 'workspace:3'], ts: new Date(Date.now() - 20 * 60_000).toISOString() },
  ];
  const { appended, parked, deps } = harness(entries);
  sweepVanished({ all: [ws(9)], ...deps });
  assert.equal(appended.length, 1, 'must start a FRESH hold for the new incident, not fall through because an unrelated old hold expired');
  assert.equal(appended[0].event, 'restart-hold');
  assert.deepEqual(parked, []);
});

test('sweepVanished: a single genuinely-closed tab among many open ones still parks normally', () => {
  // 1 vanished out of 5 open launches — below both RESTART_MIN_COUNT's
  // practical trigger and RESTART_FRACTION — must park as before. Decoy
  // taskIds start at 12 (not 2) so none collides with LAUNCHED_LONG's
  // taskId '5' — a real collision here used to trip the per-task
  // supersession guard (card #801 follow-on: task 5's own decoy launch
  // looked like a newer open launch superseding itself).
  const entries = [EPOCH_ENTRY, LAUNCHED_LONG];
  for (let i = 12; i <= 15; i++) {
    entries.push({ event: 'launch', taskId: String(i), subject: `Still-open task number ${i} long subject`, workspaceRef: `workspace:${i}`, ts: '2026-08-02T10:00:00.000Z' });
  }
  const { appended, parked, deps } = harness(entries);
  // workspace:1 (LAUNCHED_LONG) vanishes with no title match; workspace:12-15
  // (the other 4 tracked launches) are still live and listed.
  sweepVanished({ all: [ws(12), ws(13), ws(14), ws(15)], ...deps });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].event, 'vanished');
  assert.equal(appended[0].taskId, '5');
  assert.deepEqual(parked.map(p => p.notionId), ['nid']);
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

// Scheduled-tick concurrency (adversarial review 2026-08-02): only one REAL
// sweep at a time; a crashed holder self-heals via staleness.
test('acquireRunLock: second acquire is refused while fresh, stale lock is taken over, release frees it', async () => {
  const { acquireRunLock, releaseRunLock } = require('./bsc-prune.js');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const base = mkdtempSync(join(tmpdir(), 'bsc-prune-lock-'));
  const lockDir = join(base, 'lock');
  try {
    assert.equal(acquireRunLock(lockDir, 60_000), true);
    assert.equal(acquireRunLock(lockDir, 60_000), false); // fresh → refused
    // stale meta → takeover
    writeFileSync(join(lockDir, 'meta.json'), JSON.stringify({ pid: 1, ts: Date.now() - 120_000 }));
    assert.equal(acquireRunLock(lockDir, 60_000), true);
    releaseRunLock(lockDir);
    assert.equal(acquireRunLock(lockDir, 60_000), true); // released → free
    // corrupt meta → 'error' (proceed unlocked, never permanently disabled)
    writeFileSync(join(lockDir, 'meta.json'), 'not json');
    assert.equal(acquireRunLock(lockDir, 60_000), 'error');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// No-payload reaper (card #856, Session-system overhaul S3, 4b).
const { sweepNoPayload } = require('./bsc-prune.js');

function noPayloadHarness({ priorState = {} } = {}) {
  const closed = [];
  const appended = [];
  const paged = [];
  let savedState = null;
  const deps = {
    closedRefs: new Set(),
    idleRefs: new Set(),
    isDoneTitleFn: (title) => String(title).trim().slice(0, 4).includes('✅'),
    closeWorkspaceFn: (ref) => closed.push(ref),
    loadNoPayloadStateFn: () => priorState,
    saveNoPayloadStateFn: (s) => { savedState = s; },
    pageNoPayloadCloseFn: (o, launch) => paged.push({ o, launch }),
    readLedgerEntriesFn: () => [],
    appendLedgerEntryFn: (e) => appended.push(e),
  };
  return { closed, appended, paged, deps, getSavedState: () => savedState };
}

const authDeadWs = (n) => ({ ref: `workspace:${n}`, title: `🤖 dead one ${n}` });
const ownerWs = (n) => ({ ref: `workspace:${n}`, title: `owner's own tab ${n}` });

test('sweepNoPayload: never a candidate without the 🤖 auto-dispatch marker (owner tab)', () => {
  const { closed, deps } = noPayloadHarness();
  deps.readScreenFn = () => 'Not logged in · Please run /login';
  sweepNoPayload({ all: [ownerWs(1)], dryRun: false, ...deps });
  assert.deepEqual(closed, []);
});

test('sweepNoPayload: never a candidate for the selected tab, even if 🤖 + auth-dead', () => {
  const { closed, deps } = noPayloadHarness({ priorState: { 'workspace:1': 2 } });
  deps.readScreenFn = () => 'Not logged in';
  sweepNoPayload({ all: [{ ...authDeadWs(1), selected: true }], dryRun: false, ...deps });
  assert.deepEqual(closed, []);
});

// Crown (owner-loop) tabs — task #1751. This is the THIRD close path in
// bsc-prune.js and the one an owner tab is most exposed to: it decides from
// SCREEN CONTENTS, and an owner loop parked at an empty prompt looks exactly
// like an auth-dead husk.
const crownWs = (n) => ({ ref: `workspace:${n}`, title: `👑 🤖 OWNER — Linear migration to done ${n}` });

test('sweepNoPayload: a crown tab is never a candidate, even 🤖 + auth-dead + already quarantined twice', () => {
  const { closed, appended, paged, deps } = noPayloadHarness({ priorState: { 'workspace:1': 2 } });
  deps.readScreenFn = () => 'Not logged in · Please run /login';
  sweepNoPayload({ all: [crownWs(1)], dryRun: false, ...deps });
  assert.deepEqual(closed, []);
  assert.deepEqual(appended, []);
  assert.deepEqual(paged, []);
});

test('sweepNoPayload: the close-site veto holds even if a crown tab reaches toClose via prior state', () => {
  // Defense in depth (reviewer catch): the candidate filter is not the only
  // guard. Drive a crown tab all the way to the close loop by pairing it with
  // a NON-crown tab so the sweep does real work, and assert only the worker
  // closes.
  const { closed, deps } = noPayloadHarness({ priorState: { 'workspace:1': 2, 'workspace:2': 2 } });
  deps.readScreenFn = () => 'Not logged in · Please run /login';
  sweepNoPayload({ all: [crownWs(1), authDeadWs(2)], dryRun: false, ...deps });
  assert.deepEqual(closed, ['workspace:2']);
});

test('sweepNoPayload: first sighting quarantines, does not close', () => {
  const { closed, getSavedState, deps } = noPayloadHarness();
  deps.readScreenFn = () => 'Not logged in · Please run /login';
  sweepNoPayload({ all: [authDeadWs(1)], dryRun: false, ...deps });
  assert.deepEqual(closed, []);
  assert.deepEqual(getSavedState(), { 'workspace:1': 1 });
});

test('sweepNoPayload: the 3rd consecutive sighting closes, journals a dead entry, and pages the digest', () => {
  const { closed, appended, paged, getSavedState, deps } = noPayloadHarness({ priorState: { 'workspace:1': 2 } });
  deps.readScreenFn = () => 'Not logged in · Please run /login';
  sweepNoPayload({ all: [authDeadWs(1)], dryRun: false, ...deps });
  assert.deepEqual(closed, ['workspace:1']);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].event, 'dead');
  assert.equal(appended[0].reason, 'no-payload');
  assert.equal(paged.length, 1);
  assert.deepEqual(getSavedState(), {}); // dropped once closed, not carried forward
});

test('sweepNoPayload: --dry-run never closes, never persists state, never pages', () => {
  const { closed, appended, paged, getSavedState, deps } = noPayloadHarness({ priorState: { 'workspace:1': 2 } });
  deps.readScreenFn = () => 'Not logged in · Please run /login';
  sweepNoPayload({ all: [authDeadWs(1)], dryRun: true, ...deps });
  assert.deepEqual(closed, []);
  assert.deepEqual(appended, []);
  assert.deepEqual(paged, []);
  assert.equal(getSavedState(), null, 'dry-run must never persist quarantine state');
});

test('sweepNoPayload: a normal working pane is never flagged, regardless of prior quarantine state', () => {
  const { closed, getSavedState, deps } = noPayloadHarness({ priorState: { 'workspace:1': 2 } });
  deps.readScreenFn = () => '│ ctx 42% │ doing real work';
  sweepNoPayload({ all: [authDeadWs(1)], dryRun: false, ...deps });
  assert.deepEqual(closed, []);
  assert.deepEqual(getSavedState(), {}, 'recovery clears state instead of decaying');
});

test('sweepNoPayload: NO_PAYLOAD_REAPER_DISABLED=1 kill switch short-circuits entirely (no screen reads, no state writes)', () => {
  const { closed, getSavedState, deps } = noPayloadHarness({ priorState: { 'workspace:1': 2 } });
  deps.readScreenFn = () => { throw new Error('must not be called'); };
  process.env.NO_PAYLOAD_REAPER_DISABLED = '1';
  try {
    assert.doesNotThrow(() => sweepNoPayload({ all: [authDeadWs(1)], dryRun: false, ...deps }));
  } finally { delete process.env.NO_PAYLOAD_REAPER_DISABLED; }
  assert.deepEqual(closed, []);
  assert.equal(getSavedState(), null);
});

test('sweepNoPayload: a ref already in idleRefs (dead process — the pre-existing idle-unmarked bucket) is never a candidate here', () => {
  const { closed, deps } = noPayloadHarness();
  deps.readScreenFn = () => { throw new Error('must not be called for an idle ref'); };
  deps.idleRefs = new Set(['workspace:1']);
  sweepNoPayload({ all: [authDeadWs(1)], dryRun: false, ...deps });
  assert.deepEqual(closed, []);
});
