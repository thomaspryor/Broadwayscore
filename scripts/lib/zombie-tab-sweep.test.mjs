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

test('live duplicate by identical (truncated) title → corpse without any ledger mapping', () => {
  const title = '🤖⚡ Data·Gap-audit checkpoint writes are whole-object + unl';
  const r = classify({
    deadAutoTabs: [dead('workspace:7', title)],
    liveWorkspaces: [{ ref: 'workspace:8', title }],
  });
  assert.equal(r.corpses.length, 1);
  assert.equal(r.corpses[0].reason, 'live-duplicate');
});

test('selected tab is never touched even if dead and completed', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:9', '🤖⚡ Data·done', { selected: true })],
    launches: { 'workspace:9': { taskId: 905 } },
    statuses: { 905: 'completed' },
  });
  assert.equal(r.corpses.length + r.revive.length + r.report.length, 0);
});

test('non-🤖 tab is never a candidate (defense in depth)', () => {
  const r = classify({
    deadAutoTabs: [dead('workspace:10', 'owner tab no marker')],
    launches: { 'workspace:10': { taskId: 905 } },
    statuses: { 905: 'completed' },
  });
  assert.equal(r.corpses.length + r.revive.length + r.report.length, 0);
});

test('revive is capped per tick, remainder deferred', () => {
  const tabs = [];
  const launches = {};
  const statuses = {};
  for (let i = 0; i < REVIVE_CAP_PER_TICK + 2; i++) {
    tabs.push(dead(`workspace:${20 + i}`, `🤖⚡ Data·stuck ${i}`));
    launches[`workspace:${20 + i}`] = { taskId: 800 + i };
    statuses[800 + i] = 'pending';
  }
  const r = classify({ deadAutoTabs: tabs, launches, statuses });
  assert.equal(r.revive.length, REVIVE_CAP_PER_TICK);
  assert.equal(r.reviveDeferred.length, 2);
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

test('normalizeTitle: whitespace collapsed, 40-char prefix', () => {
  assert.equal(normalizeTitle('  a   b  '), 'a b');
  assert.equal(normalizeTitle('x'.repeat(60)).length, 40);
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
  assert.equal(calls.ledger.filter(e => e.event === 'prune-closed' && e.reason === 'zombie-task-completed').length, 1);
  assert.equal(calls.paged, 1);
});

test('sweepZombieTabs: revive skipped (husk still closed) once dead attempts hit the guard threshold', () => {
  const prune = require('../bsc-prune.js');
  const { DEAD_ATTEMPT_LIMIT } = require('./dispatch-ledger.js');
  const calls = { closed: [], redispatched: [], paged: [] };
  const deadEntries = [];
  for (let i = 0; i < DEAD_ATTEMPT_LIMIT; i++) {
    deadEntries.push({ event: 'launch', workspaceRef: `workspace:${60 + i}`, taskId: 914, subject: 'b', ts: `2026-08-03T0${i}:00:00Z` });
    deadEntries.push({ event: 'dead', workspaceRef: `workspace:${60 + i}`, taskId: 914, ts: `2026-08-03T0${i}:30:00Z` });
  }
  const entries = deadEntries.concat([{ event: 'launch', workspaceRef: 'workspace:70', taskId: 914, subject: 'b', ts: '2026-08-03T05:00:00Z' }]);
  prune.sweepZombieTabs({
    all: [{ ref: 'workspace:70', title: '🤖⚡ Data·keeps dying' }],
    idle: [{ ref: 'workspace:70', title: '🤖⚡ Data·keeps dying' }],
    dryRun: false,
    closeWorkspaceFn: (ref) => calls.closed.push(ref),
    appendLedgerEntryFn: () => {},
    readLedgerEntriesFn: () => entries,
    taskStatusByIdFn: () => 'pending',
    redispatchFn: (id) => calls.redispatched.push(id),
    pageFn: (p) => calls.paged.push(p),
  });
  assert.deepEqual(calls.closed, ['workspace:70'], 'husk must still close');
  assert.deepEqual(calls.redispatched, [], 'must NOT re-dispatch past the death threshold');
  assert.deepEqual(calls.paged[0].revive, [], 'guarded task must not be paged as revived');
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
