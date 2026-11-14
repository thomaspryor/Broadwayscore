import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { computeLaneTroubleRate } = require('./lib/lane-trouble-rate.js');
const { JOB_EVENTS } = require('./lib/dispatch-ledger.js');

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const t = (min) => new Date(NOW - 3 * 86400000 + min * 60000).toISOString();
const launch = (min, ref, taskId) => ({ ts: t(min), event: 'launch', taskId, workspaceRef: ref });
const ev = (min, event, taskId, extra = {}) => ({ ts: t(min), event, taskId, ...extra });

// Task 1: the BRO-2959 shape, a cmux launch row AND a headless launch row, then orphan -> retry -> done.
// Task 2: headless, clean. Task 3: cmux launch that died. Task 4: cmux, clean.
const FIXTURE = [
  launch(0, 'workspace:1', '1'), launch(1, 'headless:1', '1'),
  ev(2, JOB_EVENTS.SPAWNED, '1'), ev(10, JOB_EVENTS.ORPHANED, '1'), ev(11, JOB_EVENTS.RETRIED, '1'), ev(20, JOB_EVENTS.DONE, '1'),
  launch(30, 'headless:2', '2'), ev(31, JOB_EVENTS.SPAWNED, '2'), ev(40, JOB_EVENTS.DONE, '2'),
  launch(50, 'workspace:3', '3'), ev(51, 'dead', '3', { workspaceRef: 'workspace:3' }),
  launch(60, 'workspace:4', '4'),
];

test('trouble is counted per lane, never across lanes', () => {
  const { lanes } = computeLaneTroubleRate(FIXTURE, { nowMs: NOW, windowDays: 7 });
  assert.equal(lanes.headless.tasks, 2);
  assert.equal(lanes.headless.troubledTasks, 1);
  assert.equal(lanes.headless.troubledLaunches, 1);
  assert.deepEqual(lanes.headless.events, { 'job-orphaned': 1, 'job-retried': 1 });
  // task 1's cmux launch row does NOT inherit the headless orphan/retry
  assert.equal(lanes.workspace.tasks, 3);
  assert.equal(lanes.workspace.troubledTasks, 1);
  assert.deepEqual(lanes.workspace.events, { dead: 1 });
});

test('a dead row written just BEFORE its launch row (failedLaunchEntries order) counts; launch-failed without a ref counts', () => {
  const rows = [
    { ts: new Date(NOW - 86400000).toISOString(), event: 'dead', taskId: '11', workspaceRef: 'workspace:11' },
    { ts: new Date(NOW - 86400000 + 1).toISOString(), event: 'launch', taskId: '11', workspaceRef: 'workspace:11' },
    { ts: new Date(NOW - 3600000).toISOString(), event: 'launch', taskId: '12', workspaceRef: 'workspace:12' },
    { ts: new Date(NOW - 3500000).toISOString(), event: 'launch-failed', taskId: '12' },
  ];
  const { lanes } = computeLaneTroubleRate(rows, { nowMs: NOW });
  assert.equal(lanes.workspace.troubledTasks, 2);
});

test('job-failed counts for headless; successful end state does not hide earlier trouble', () => {
  const rows = [launch(0, 'headless:9', '9'), ev(1, JOB_EVENTS.FAILED, '9'), ev(2, JOB_EVENTS.DONE, '9')];
  const { lanes } = computeLaneTroubleRate(rows, { nowMs: NOW });
  assert.equal(lanes.headless.troubledTaskRate, 1);
});

test('events after a redispatch belong to the newer launch only', () => {
  const rows = [launch(0, 'headless:5', '5'), ev(1, JOB_EVENTS.ORPHANED, '5'), launch(20, 'headless:5', '5'), ev(21, JOB_EVENTS.DONE, '5')];
  const { lanes } = computeLaneTroubleRate(rows, { nowMs: NOW });
  assert.equal(lanes.headless.launches, 2);
  assert.equal(lanes.headless.troubledLaunches, 1);
  assert.equal(lanes.headless.tasks, 1);
  assert.equal(lanes.headless.troubledTasks, 1);
});

test('launches outside the window are ignored; nowMs is required', () => {
  const old = [{ ts: '2026-09-01T00:00:00.000Z', event: 'launch', taskId: '7', workspaceRef: 'headless:7' }];
  assert.deepEqual(computeLaneTroubleRate(old, { nowMs: NOW }).lanes, {});
  assert.throws(() => computeLaneTroubleRate([], {}), /nowMs/);
});

test('the CLI resolves the ledger from the main repo root, not __dirname', () => {
  const src = require('node:fs').readFileSync(new URL('./audit-lane-trouble-rate.js', import.meta.url), 'utf8');
  assert.match(src, /MAIN_REPO_ROOT/);
  assert.doesNotMatch(src, /__dirname.*dispatch-ledger/);
  assert.throws(() => execFileSync('node', [new URL('./audit-lane-trouble-rate.js', import.meta.url).pathname, '--days=abc'], { stdio: 'pipe' }), /status 2|Command failed/);
});
