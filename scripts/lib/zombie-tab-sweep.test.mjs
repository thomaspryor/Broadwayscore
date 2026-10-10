import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyZombieTabs, normalizeTitle, REVIVE_CAP_PER_TICK } = require('./zombie-tab-sweep.js');

const isAuto = (t) => t.includes('🤖');
const dead = (ref, title, extra = {}) => ({ ref, title, ...extra });

function classify({ deadAutoTabs, liveWorkspaces = [], launches = {}, statuses = {} }) {
  return classifyZombieTabs({
    deadAutoTabs,
    liveWorkspaces,
    launchByRef: (ref) => launches[ref] || null,
    taskStatusById: (id) => statuses[id] ?? null,
    hasAutoDispatchMarker: isAuto,
  });
}

test('completed task → corpse', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:1', '🤖⚡ Data·done thing')],
    launches: { 'workspace:1': { taskId: 905, subject: 's' } },
    statuses: { 905: 'completed' },
  });
  assert.equal(r.corpses.length, 1);
  assert.equal(r.corpses[0].reason, 'task-completed');
  assert.equal(r.revive.length + r.report.length, 0);
});

test('pending task → revive (never booted)', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:2', '🤖⚡ Data·stuck thing')],
    launches: { 'workspace:2': { taskId: 914 } },
    statuses: { 914: 'pending' },
  });
  assert.equal(r.revive.length, 1);
  assert.equal(r.revive[0].taskId, '914');
  assert.equal(r.corpses.length + r.report.length, 0);
});

test('in_progress task → report only (reconciler territory)', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:3', '🤖⚡ Data·mid-work')],
    launches: { 'workspace:3': { taskId: 888 } },
    statuses: { 888: 'in_progress' },
  });
  assert.equal(r.report.length, 1);
  assert.equal(r.report[0].reason, 'reconciler-territory');
  assert.equal(r.corpses.length + r.revive.length, 0);
});

test('unmapped tab (no launch entry, no task) → report only', () => {
  const r = classify({ deadAutoTabs: [dead('workspace:4', '🤖⚡ Data·mystery')] });
  assert.equal(r.report.length, 1);
  assert.equal(r.report[0].reason, 'unmapped');
});

test('live duplicate by taskId → corpse even when task still pending', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:5', '🤖⚡ Data·Gap-audit checkpoint writes are whol')],
    liveWorkspaces: [{ ref: 'workspace:6', title: '🤖⚡ Data·Gap-audit LIVE retitled' }],
    launches: {
      'workspace:5': { taskId: 923 },
      'workspace:6': { taskId: 923 },
    },
    statuses: { 923: 'pending' },
  });
  assert.equal(r.corpses.length, 1);
  assert.equal(r.corpses[0].reason, 'live-duplicate');
});

test('title equality only counts as duplicate when the dead tab has NO taskId mapping', () => {
  const title = '🤖⚡ Data·Gap-audit checkpoint writes are whole-object + unl';
  // Unmapped dead tab + identically titled live tab → corpse.
  const unmapped = classify({
    deadAutoTabs: [dead('workspace:7', title)],
    liveWorkspaces: [{ ref: 'workspace:8', title }],
  });
  assert.equal(unmapped.corpses.length, 1);
  assert.equal(unmapped.corpses[0].reason, 'live-duplicate');

  // MAPPED pending dead tab whose title matches a live tab of a DIFFERENT
  // task → revive, never a title-based corpse (a sibling task sharing a
  // card-name prefix must not be closed as a "duplicate").
  const mapped = classify({
    deadAutoTabs: [dead('workspace:9', title)],
    liveWorkspaces: [{ ref: 'workspace:10', title }],
    launches: { 'workspace:9': { taskId: 930 }, 'workspace:10': { taskId: 931 } },
    statuses: { 930: 'pending', 931: 'pending' },
  });
  assert.equal(mapped.corpses.length, 0);
  assert.equal(mapped.revive.length, 1);
  assert.equal(mapped.revive[0].taskId, '930');
});

test('different full titles are never duplicates (no prefix slicing)', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:11', '🤖⚡ Data·Coverage Verdict S0: foundations — explainExclusio')],
    liveWorkspaces: [{ ref: 'workspace:12', title: '🤖⚡ Data·Coverage Verdict S0: foundations — explainExclusion + more' }],
  });
  assert.equal(r.corpses.length, 0);
  assert.equal(r.report.length, 1); // unmapped, left alone
});

test('selected tab is never touched even if dead and completed', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:13', '🤖⚡ Data·done', { selected: true })],
    launches: { 'workspace:13': { taskId: 905 } },
    statuses: { 905: 'completed' },
  });
  assert.equal(r.corpses.length + r.revive.length + r.report.length, 0);
});

test('non-🤖 tab is never a candidate (defense in depth)', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:14', 'owner tab no marker')],
    launches: { 'workspace:14': { taskId: 905 } },
    statuses: { 905: 'completed' },
  });
  assert.equal(r.corpses.length + r.revive.length + r.report.length, 0);
});

test('classify returns ALL revive candidates — the caller applies guard then cap', () => {
  const tabs = [];
  const launches = {};
  const statuses = {};
  for (let i = 0; i < REVIVE_CAP_PER_TICK + 2; i++) {
    tabs.push(dead(`workspace:${20 + i}`, `🤖⚡ Data·stuck ${i}`));
    launches[`workspace:${20 + i}`] = { taskId: 800 + i };
    statuses[800 + i] = 'pending';
  }
  const r = classify({ deadAutoTabs: tabs, launches, statuses });
  assert.equal(r.revive.length, REVIVE_CAP_PER_TICK + 2);
});

test('launchByRef throwing is treated as unmapped, never a crash', () => {
  const r = classifyZombieTabs({
    deadAutoTabs: [dead('workspace:30', '🤖⚡ Data·boom')],
    liveWorkspaces: [],
    launchByRef: () => { throw new Error('ledger unreadable'); },
    taskStatusById: () => null,
    hasAutoDispatchMarker: isAuto,
  });
  assert.equal(r.report.length, 1);
  assert.equal(r.report[0].reason, 'unmapped');
});

test('normalizeTitle collapses whitespace, keeps the full title', () => {
  assert.equal(normalizeTitle('  a   b  '), 'a b');
  assert.equal(normalizeTitle('x'.repeat(60)).length, 60);
});

test('sweepZombieTabs wiring: dry-run closes nothing, real run closes corpse and re-dispatches pending', () => {
  const prune = require('../bsc-prune.js');
  const calls = { closed: [], ledger: [], redispatched: [], paged: 0 };
  const deps = {
    all: [
      { ref: 'workspace:40', title: '🤖⚡ Data·corpse task' },
      { ref: 'workspace:41', title: '🤖⚡ Data·never booted' },
      { ref: 'workspace:42', title: '🤖⚡ Data·live other' },
    ],
    idle: [
      { ref: 'workspace:40', title: '🤖⚡ Data·corpse task' },
      { ref: 'workspace:41', title: '🤖⚡ Data·never booted' },
    ],
    closeWorkspaceFn: (ref) => calls.closed.push(ref),
    appendLedgerEntryFn: (e) => calls.ledger.push(e),
    readLedgerEntriesFn: () => [
      { event: 'launch', workspaceRef: 'workspace:40', taskId: 905, subject: 'a', ts: '2026-08-03T00:00:00Z' },
      { event: 'launch', workspaceRef: 'workspace:41', taskId: 914, subject: 'b', ts: '2026-08-03T00:00:01Z' },
    ],
    taskStatusByIdFn: (id) => ({ 905: 'completed', 914: 'pending' })[id] || null,
    redispatchFn: (id) => calls.redispatched.push(id),
    pageFn: () => calls.paged++,
  };

  prune.sweepZombieTabs({ ...deps, dryRun: true });
  assert.deepEqual(calls.closed, [], 'dry-run must not close');
  assert.deepEqual(calls.redispatched, [], 'dry-run must not re-dispatch');

  prune.sweepZombieTabs({ ...deps, dryRun: false });
  assert.deepEqual(calls.closed.sort(), ['workspace:40', 'workspace:41']);
  assert.deepEqual(calls.redispatched, ['914']);
  const corpseEntry = calls.ledger.find(e => e.event === 'prune-closed' && e.reason === 'zombie-task-completed');
  assert.ok(corpseEntry, 'corpse must write a prune-closed entry');
  assert.equal(corpseEntry.subject, 'a', 'entry must carry subject like pruneClosedEntry does');
  assert.equal(corpseEntry.title, '🤖⚡ Data·corpse task');
  assert.equal(calls.paged, 1);
});

test('sweepZombieTabs: close failure on the revive path must NOT re-dispatch (no concurrent double-run)', () => {
  const prune = require('../bsc-prune.js');
  const calls = { redispatched: [], paged: [] };
  prune.sweepZombieTabs({
    all: [{ ref: 'workspace:45', title: '🤖⚡ Data·never booted' }],
    idle: [{ ref: 'workspace:45', title: '🤖⚡ Data·never booted' }],
    dryRun: false,
    closeWorkspaceFn: () => { throw new Error('cmux socket flake'); },
    appendLedgerEntryFn: () => {},
    readLedgerEntriesFn: () => [{ event: 'launch', workspaceRef: 'workspace:45', taskId: 914, subject: 'b', ts: '2026-08-03T00:00:01Z' }],
    taskStatusByIdFn: () => 'pending',
    redispatchFn: (id) => calls.redispatched.push(id),
    pageFn: (p) => calls.paged.push(p),
  });
  assert.deepEqual(calls.redispatched, [], 'failed close must abort the re-dispatch');
  assert.deepEqual(calls.paged[0].revive, [], 'aborted revive must not be paged as revived');
});

test('sweepZombieTabs: guard runs before the cap — guarded tasks never burn cap slots, and guarded closes are paged', () => {
  const prune = require('../bsc-prune.js');
  const { DEAD_ATTEMPT_LIMIT } = require('./dispatch-ledger.js');
  const calls = { closed: [], redispatched: [], paged: [] };

  // Task 800 is past the death threshold; tasks 801..(801+CAP-1) are fresh.
  const entries = [];
  for (let i = 0; i < DEAD_ATTEMPT_LIMIT; i++) {
    entries.push({ event: 'launch', workspaceRef: `workspace:${70 + i}`, taskId: 800, subject: 'x', ts: `2026-08-03T0${i}:00:00Z` });
    entries.push({ event: 'dead', workspaceRef: `workspace:${70 + i}`, taskId: 800, ts: `2026-08-03T0${i}:30:00Z` });
  }
  const tabs = [{ ref: 'workspace:80', title: '🤖⚡ Data·guarded' }];
  entries.push({ event: 'launch', workspaceRef: 'workspace:80', taskId: 800, subject: 'x', ts: '2026-08-03T05:00:00Z' });
  for (let i = 0; i < REVIVE_CAP_PER_TICK; i++) {
    tabs.push({ ref: `workspace:${81 + i}`, title: `🤖⚡ Data·fresh ${i}` });
    entries.push({ event: 'launch', workspaceRef: `workspace:${81 + i}`, taskId: 801 + i, subject: `f${i}`, ts: '2026-08-03T05:00:01Z' });
  }

  prune.sweepZombieTabs({
    all: tabs, idle: tabs, dryRun: false,
    closeWorkspaceFn: (ref) => calls.closed.push(ref),
    appendLedgerEntryFn: () => {},
    readLedgerEntriesFn: () => entries,
    taskStatusByIdFn: () => 'pending',
    redispatchFn: (id) => calls.redispatched.push(id),
    pageFn: (p) => calls.paged.push(p),
  });

  // The guarded task's husk closed but not re-dispatched; ALL fresh tasks
  // got cap slots (the guarded one didn't consume any).
  assert.equal(calls.redispatched.length, REVIVE_CAP_PER_TICK);
  assert.ok(!calls.redispatched.includes('800'));
  assert.equal(calls.paged[0].guarded.length, 1, 'guarded close must be paged');
  assert.equal(calls.paged[0].guarded[0].taskId, '800');
  assert.ok(calls.closed.includes('workspace:80'), 'guarded husk must still close');
});

test('sweepZombieTabs feeds classifyZombieTabs the LAST launch for a recycled ref, not the first (card #960)', () => {
  const dispatchLedger = require('./dispatch-ledger.js');
  const entries = [
    { event: 'launch', workspaceRef: 'workspace:12', taskId: 100, ts: '2026-08-01T00:00:00Z' },
    { event: 'dead', workspaceRef: 'workspace:12', taskId: 100, ts: '2026-08-01T01:00:00Z' },
    { event: 'launch', workspaceRef: 'workspace:12', taskId: 200, ts: '2026-08-03T00:00:00Z' },
  ];
  assert.equal(dispatchLedger.launchByRef('workspace:12', entries).taskId, 200);
  assert.equal(dispatchLedger.launchByRef('workspace:99', entries), null);
});

test('sweepZombieTabs end-to-end: a recycled ref classifies against the CURRENT task, not the ref\'s original occupant (card #960)', () => {
  const prune = require('../bsc-prune.js');
  const calls = { closed: [], ledger: [], redispatched: [], paged: 0 };
  prune.sweepZombieTabs({
    all: [{ ref: 'workspace:12', title: '🤖⚡ Data·current task' }],
    idle: [{ ref: 'workspace:12', title: '🤖⚡ Data·current task' }],
    dryRun: false,
    closeWorkspaceFn: (ref) => calls.closed.push(ref),
    appendLedgerEntryFn: (e) => calls.ledger.push(e),
    // workspace:12's FIRST occupant (task 100) died and completed long ago;
    // cmux then recycled the ref onto task 200, which is still pending
    // (never booted). Routing through dispatchLedger.launchByRef (last-match)
    // must classify this as task 200's never-booted husk, not task 100's
    // already-reconciled corpse.
    readLedgerEntriesFn: () => [
      { event: 'launch', workspaceRef: 'workspace:12', taskId: 100, subject: 'old task', ts: '2026-07-01T00:00:00Z' },
      { event: 'dead', workspaceRef: 'workspace:12', taskId: 100, ts: '2026-07-01T01:00:00Z' },
      { event: 'launch', workspaceRef: 'workspace:12', taskId: 200, subject: 'current task', ts: '2026-08-03T00:00:00Z' },
    ],
    taskStatusByIdFn: (id) => ({ 100: 'completed', 200: 'pending' })[id] || null,
    redispatchFn: (id) => calls.redispatched.push(id),
    pageFn: () => calls.paged++,
  });
  assert.deepEqual(calls.closed, ['workspace:12']);
  // Before the fix, first-match would have read task 100 (completed) here
  // and closed the tab as a corpse instead of reviving task 200.
  assert.deepEqual(calls.redispatched, ['200']);
});

test('sweepZombieTabs kill switch: ZOMBIE_TAB_SWEEP_DISABLED=1 does nothing', () => {
  const prune = require('../bsc-prune.js');
  const calls = { closed: [] };
  process.env.ZOMBIE_TAB_SWEEP_DISABLED = '1';
  try {
    prune.sweepZombieTabs({
      all: [{ ref: 'workspace:50', title: '🤖⚡ Data·x' }],
      idle: [{ ref: 'workspace:50', title: '🤖⚡ Data·x' }],
      dryRun: false,
      closeWorkspaceFn: (ref) => calls.closed.push(ref),
      appendLedgerEntryFn: () => {},
      readLedgerEntriesFn: () => [],
      taskStatusByIdFn: () => 'completed',
      redispatchFn: () => {},
      pageFn: () => {},
    });
  } finally { delete process.env.ZOMBIE_TAB_SWEEP_DISABLED; }
  assert.deepEqual(calls.closed, []);
});

// ── BRO-2586: reclaiming 'unmapped' dead 🤖 tabs (no ledger/task mapping) ──

test('sweepZombieTabs reclaim: an unmapped dead 🤖 tab (no ledger record) is closed, ledger-written, and reaches pageFn', () => {
  const prune = require('../bsc-prune.js');
  const calls = { closed: [], ledger: [], paged: null };
  const ws = { ref: 'workspace:70', title: '🤖⚡ Data·orphan task', selected: false };
  prune.sweepZombieTabs({
    all: [ws],
    idle: [ws],
    dryRun: false,
    closeWorkspaceFn: (ref) => calls.closed.push(ref),
    appendLedgerEntryFn: (e) => calls.ledger.push(e),
    readLedgerEntriesFn: () => [], // no launch record for this ref anywhere
    listWorkspacesFn: () => [ws], // fresh re-list: unchanged
    claudeAliveInFn: () => false,
    surfaceAliveInFn: () => false,
    taskStatusByIdFn: () => null,
    redispatchFn: () => { throw new Error('must not redispatch an unmapped reclaim — no known task'); },
    pageFn: (payload) => { calls.paged = payload; },
  });
  assert.deepEqual(calls.closed, ['workspace:70']);
  assert.equal(calls.ledger.length, 1);
  assert.equal(calls.ledger[0].event, 'prune-closed');
  assert.equal(calls.ledger[0].reason, 'zombie-unmapped');
  assert.equal(calls.ledger[0].workspaceRef, 'workspace:70');
  assert.deepEqual(calls.paged.reclaimed.map(r => r.ref), ['workspace:70']);
});

test('sweepZombieTabs reclaim: RECLAIM_UNMAPPED_DISABLED=1 leaves unmapped dead 🤖 tabs alone', () => {
  const prune = require('../bsc-prune.js');
  const calls = { closed: [] };
  const ws = { ref: 'workspace:71', title: '🤖⚡ Data·orphan task 2', selected: false };
  process.env.RECLAIM_UNMAPPED_DISABLED = '1';
  try {
    prune.sweepZombieTabs({
      all: [ws], idle: [ws], dryRun: false,
      closeWorkspaceFn: (ref) => calls.closed.push(ref),
      appendLedgerEntryFn: () => {},
      readLedgerEntriesFn: () => [],
      listWorkspacesFn: () => { throw new Error('must not re-list when reclaim is disabled'); },
      taskStatusByIdFn: () => null,
      redispatchFn: () => {},
      pageFn: () => {},
    });
  } finally { delete process.env.RECLAIM_UNMAPPED_DISABLED; }
  assert.deepEqual(calls.closed, []);
});

test('sweepZombieTabs reclaim: a fresh close-time liveness re-probe that says ALIVE overrides the classify-time dead verdict', () => {
  // Ship-check catch (Codex adversarial review): a hardcoded hasLiveClaude:
  // false at close time would prove nothing about a process that started (or
  // was found alive) in the window between classification and this loop.
  const prune = require('../bsc-prune.js');
  const calls = { closed: [] };
  const ws = { ref: 'workspace:72', title: '🤖⚡ Data·revived task', selected: false };
  prune.sweepZombieTabs({
    all: [ws], idle: [ws], dryRun: false,
    closeWorkspaceFn: (ref) => calls.closed.push(ref),
    appendLedgerEntryFn: () => {},
    readLedgerEntriesFn: () => [],
    listWorkspacesFn: () => [ws],
    claudeAliveInFn: () => true,
    surfaceAliveInFn: () => true,
    taskStatusByIdFn: () => null,
    redispatchFn: () => {},
    pageFn: () => {},
  });
  assert.deepEqual(calls.closed, []);
});

test('sweepZombieTabs reclaim: a ledger read failure fails closed — no reclaim this tick', () => {
  // Pre-existing behavior for corpses/revive already treats a ledger-read
  // failure as "no launch found for anyone" (harmless — lands in report, not
  // closed). This proves the NEW destructive reclaim path doesn't inherit
  // that fail-open direction.
  const prune = require('../bsc-prune.js');
  const calls = { closed: [] };
  const ws = { ref: 'workspace:73', title: '🤖⚡ Data·orphan task 3', selected: false };
  prune.sweepZombieTabs({
    all: [ws], idle: [ws], dryRun: false,
    closeWorkspaceFn: (ref) => calls.closed.push(ref),
    appendLedgerEntryFn: () => {},
    readLedgerEntriesFn: () => { throw new Error('ledger unreadable'); },
    listWorkspacesFn: () => { throw new Error('must not re-list when the ledger read already failed closed'); },
    taskStatusByIdFn: () => null,
    redispatchFn: () => {},
    pageFn: () => {},
  });
  assert.deepEqual(calls.closed, []);
});

test('sweepZombieTabs reclaim: TOCTOU re-list catches the tab becoming selected between classify and close', () => {
  const prune = require('../bsc-prune.js');
  const calls = { closed: [] };
  const stale = { ref: 'workspace:74', title: '🤖⚡ Data·orphan task 4', selected: false };
  const fresh = { ref: 'workspace:74', title: '🤖⚡ Data·orphan task 4', selected: true };
  prune.sweepZombieTabs({
    all: [stale], idle: [stale], dryRun: false,
    closeWorkspaceFn: (ref) => calls.closed.push(ref),
    appendLedgerEntryFn: () => {},
    readLedgerEntriesFn: () => [],
    listWorkspacesFn: () => [fresh],
    claudeAliveInFn: () => false,
    surfaceAliveInFn: () => false,
    taskStatusByIdFn: () => null,
    redispatchFn: () => {},
    pageFn: () => {},
  });
  assert.deepEqual(calls.closed, []);
});

// ── Crown (owner-loop) tabs — task #1751 ───────────────────────────────────

test('crown tab with a completed task → reported, never a corpse', () => {
  // Without the crown branch this is the strongest close signal there is
  // (dead tab + task marked completed) and the owner loop would be closed.
  const r = classify({
    deadAutoTabs: [dead('workspace:5', '👑 🤖 OWNER — Linear migration to done (8/14)')],
    launches: { 'workspace:5': { taskId: 1751, subject: 'OWNER: drive the Linear migration to done' } },
    statuses: { 1751: 'completed' },
  });
  assert.deepEqual(r.corpses, []);
  assert.equal(r.report.length, 1);
  assert.equal(r.report[0].reason, 'crown-tab');
  // The report must carry the ledger identity a human needs to act on it —
  // that is the whole reason this is reported rather than skipped outright.
  assert.equal(r.report[0].taskId, '1751');
  assert.equal(r.report[0].subject, 'OWNER: drive the Linear migration to done');
});

test('crown tab with a pending task → reported, never headlessly revived', () => {
  // Re-crowning is an owner decision that must go through the dispatch ledger,
  // not a 5-minute headless sweep.
  const r = classify({
    deadAutoTabs: [dead('workspace:5', '✅ 👑 🤖 OWNER — Linear migration to done')],
    launches: { 'workspace:5': { taskId: 1751, subject: 's' } },
    statuses: { 1751: 'pending' },
  });
  assert.deepEqual(r.revive, []);
  assert.deepEqual(r.corpses, []);
  assert.equal(r.report[0].reason, 'crown-tab');
});

test('crown tab duplicating a LIVE tab is still reported, not closed', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:5', '👑 🤖 OWNER — Linear migration to done')],
    liveWorkspaces: [{ ref: 'workspace:9', title: '👑 🤖 OWNER — Linear migration to done' }],
    launches: {
      'workspace:5': { taskId: 1751, subject: 's' },
      'workspace:9': { taskId: 1751, subject: 's' },
    },
    statuses: { 1751: 'in_progress' },
  });
  assert.deepEqual(r.corpses, []);
  assert.equal(r.report[0].reason, 'crown-tab');
});

test('a non-crown 🤖 tab is unaffected by the crown branch', () => {
  // Regression fence: the incident title itself carries no leading 👑, so it
  // must still classify exactly as it did before.
  const r = classify({
    deadAutoTabs: [dead('workspace:5', '✅ 🤖🔮 Data·OWNER: drive the Linear migration to done — own, m')],
    launches: { 'workspace:5': { taskId: 1751, subject: 's' } },
    statuses: { 1751: 'completed' },
  });
  assert.equal(r.corpses.length, 1);
  assert.equal(r.corpses[0].reason, 'task-completed');
  assert.equal(r.report.length, 0);
});
