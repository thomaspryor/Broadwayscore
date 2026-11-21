/**
 * paused-hold.test.mjs — BRO-6764.
 *
 * A worker reported BRO-6764 paused with RECHECK-AFTER 2026-11-03 and the
 * dispatch watchdog relaunched it 19s later: Paused is a backlog-type state,
 * so neither the watchdog's queue filter nor linear-next's started/reported
 * guards held it. Both now apply cloud-worker-pick.js historySkipReason.
 * Comment shapes below are the real BRO-6764 thread (report, then a claim
 * receipt posted by automation after it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const src = require('./linear-watchdog-source.js');
const ld = require('./linear-dispatch.js');
const core = require('./dispatch-watchdog-core.js');
const drain = require('./linear-drain-parked.js');

// The watchdog queue = tasks still 'pending' (planSweep's p01Queue only takes those).
const queued = (res) => [...res.tasks.values()].filter((t) => t.status === 'pending').map((t) => t.id);

const NOW = Date.parse('2026-11-01T16:34:30Z');
const ARMED = 'Do the thing.\n\nVERIFY: node --test tests/unit/morning-digest-action.test.mjs\n';
const PAUSED_REPORT = '**Session report (paused)**\n\nCutover landed. Paused on a RECHECK-AFTER wait: RECHECK-AFTER: 2026-11-03. VERIFY: node --test tests/unit/morning-digest-action.test.mjs';
const PAUSED_REPORT_NO_STAMP = '**Session report (paused)**\n\nRan out of time budget; seasons 2015-16 half done, next command in STATE.md.';

function issue(over = {}) {
  return {
    identifier: 'BRO-6764',
    title: 'Mac-to-cloud Phase 2b',
    description: ARMED,
    priority: 1,
    state: { name: 'Paused', type: 'backlog' },
    ...over,
  };
}
const at = (iso, body) => ({ createdAt: iso, body });

function clientFor(pages, commentsById, { failComments = false } = {}) {
  return {
    graphql: async () => ({ issues: { nodes: pages, pageInfo: { hasNextPage: false } } }),
    listIssueComments: async (ids) => {
      if (failComments) throw new Error('Linear 503');
      return new Map(ids.map((id) => [id, commentsById[id] || []]));
    },
  };
}

test('watchdog queue holds a card paused with a RECHECK-AFTER date still ahead (the BRO-6764 relaunch)', async () => {
  const comments = {
    'BRO-6764': [
      at('2026-11-01T16:34:09Z', PAUSED_REPORT),
      at('2026-11-01T16:34:50Z', 'Claimed by local session abc on Toms-Mac-Studio.local'),
    ],
    'BRO-7000': [],
  };
  const todo = issue({ identifier: 'BRO-7000', state: { name: 'Todo', type: 'unstarted' } });
  const res = await src.fetchLinearWatchdogTasks(clientFor([issue(), todo], comments), { now: NOW });
  assert.equal(res.ok, true);
  assert.deepEqual(queued(res), ['linear:BRO-7000']);
  assert.equal(res.eligible, 1);
  assert.deepEqual(res.pauseHeld, [{ taskId: 'linear:BRO-6764', reason: 'recheck-pending' }]);
  // Still visible (open) to blocked-job / unlanded-work detection, just not queueable.
  const held = res.tasks.get('linear:BRO-6764');
  assert.equal(held.status, 'in_progress'); // isTaskOpen() accepts it, p01Queue does not
  assert.equal(held.pauseHold, 'recheck-pending');
});

test('watchdog queue takes a paused card back once its RECHECK-AFTER date has passed and the cooldown is over', async () => {
  const comments = { 'BRO-6764': [at('2026-11-01T16:34:09Z', PAUSED_REPORT)] };
  const later = Date.parse('2026-11-03T06:00:00Z');
  const res = await src.fetchLinearWatchdogTasks(clientFor([issue()], comments), { now: later });
  assert.deepEqual(queued(res), ['linear:BRO-6764']);
});

test('watchdog queue holds a P0/P1 card paused without a stamp for the 24h cooldown only', async () => {
  const comments = { 'BRO-6764': [at('2026-11-01T10:00:00Z', PAUSED_REPORT_NO_STAMP)] };
  const soon = await src.fetchLinearWatchdogTasks(clientFor([issue()], comments), { now: NOW });
  assert.deepEqual(soon.pauseHeld, [{ taskId: 'linear:BRO-6764', reason: 'recently-paused' }]);
  const dayLater = await src.fetchLinearWatchdogTasks(clientFor([issue()], comments), { now: Date.parse('2026-11-02T11:00:00Z') });
  assert.deepEqual(queued(dayLater), ['linear:BRO-6764']);
});

test('a person commenting after the pause re-opens a recheck-pending card', async () => {
  const comments = { 'BRO-6764': [
    at('2026-11-01T10:00:00Z', PAUSED_REPORT),
    at('2026-11-02T12:00:00Z', 'Owner here: the email arrived, go ahead and delete the compare script.'),
  ] };
  const res = await src.fetchLinearWatchdogTasks(clientFor([issue()], comments), { now: Date.parse('2026-11-02T13:00:00Z') });
  assert.deepEqual(queued(res), ['linear:BRO-6764']);
});

test('a failed comment read fails open (queue unchanged) and says so', async () => {
  const res = await src.fetchLinearWatchdogTasks(clientFor([issue()], {}, { failComments: true }), { now: NOW });
  assert.equal(res.ok, true);
  assert.deepEqual(queued(res), ['linear:BRO-6764']);
  assert.match(res.pauseHistory, /^failed: Linear 503/);
});

test('linear-next pausedHoldGuard refuses the live BRO-6764 shape and --force waives it', () => {
  const live = issue({ comments: { nodes: [
    at('2026-11-01T16:34:09Z', PAUSED_REPORT),
    at('2026-11-01T15:08:52Z', 'Dispatched 6dee7c7f to linear:BRO-6764-mvxwh2b5 at 2026-11-01T15:08:52.282Z (headless)'),
  ] } });
  assert.match(ld.pausedHoldGuard(live, {}, NOW), /recheck-pending/);
  assert.equal(ld.pausedHoldGuard(live, { force: true }, NOW), null);
  assert.equal(ld.pausedHoldGuard(live, { 'dry-run': true }, NOW), null);
});

test('linear-next pausedHoldGuard leaves ordinary Backlog/Todo dispatches alone', () => {
  // No session report at all: the queue's 'backlog-unexplained' rule must not leak into --id dispatch.
  const backlog = issue({ comments: { nodes: [at('2026-10-20T10:00:00Z', 'Some context from the filer.')] } });
  assert.equal(ld.pausedHoldGuard(backlog, {}, NOW), null);
  assert.equal(ld.pausedHoldGuard(issue({ comments: { nodes: [] } }), {}, NOW), null);
  assert.equal(ld.pausedHoldGuard(issue(), {}, NOW), null);
  // Paused long ago with the date passed: free to run.
  const old = issue({ comments: { nodes: [at('2026-10-20T10:00:00Z', PAUSED_REPORT.replace('2026-11-03', '2026-10-25'))] } });
  assert.equal(ld.pausedHoldGuard(old, {}, NOW), null);
});

test('linear-next pausedHoldGuard holds a card paused 3+ times and one waiting on the owner (the BRO-6417 loop)', () => {
  const thrice = issue({ comments: { nodes: [
    at('2026-10-20T10:00:00Z', PAUSED_REPORT_NO_STAMP),
    at('2026-10-24T10:00:00Z', PAUSED_REPORT_NO_STAMP),
    at('2026-10-28T10:00:00Z', PAUSED_REPORT_NO_STAMP),
    at('2026-10-28T10:05:00Z', 'Dispatched 1a2b3c4d to linear:BRO-6764-x at 2026-10-28T10:05:00Z (headless)'),
  ] } });
  assert.match(ld.pausedHoldGuard(thrice, {}, NOW), /paused-repeatedly/);
  const owner = issue({ comments: { nodes: [
    at('2026-10-31T10:00:00Z', '**Session report (paused)**\n\nDECISION NEEDED: which hosting plan. Waiting on the owner decision.'),
  ] } });
  assert.match(ld.pausedHoldGuard(owner, {}, NOW), /awaiting-owner/);
});

test('dead-launch retry skips a task held by its pause history', () => {
  const task = { id: 'linear:BRO-6764', subject: 'x', description: '[linear:BRO-6764] P1 Next · Paused · no-category\n', status: 'in_progress', pauseHold: 'recheck-pending' };
  const entries = [
    { event: 'launch', taskId: 'linear:BRO-6764', ts: '2026-11-01T15:00:00.000Z' },
    { event: 'dead', taskId: 'linear:BRO-6764', ts: '2026-11-01T15:30:00.000Z' },
  ];
  const plan = core.planSweep(entries, new Map([[task.id, task]]), { now: NOW });
  assert.deepEqual(plan.toDispatch.map((t) => t.taskId), []);
});

test('parked drain does not spend a slot on a card linear-next would refuse', () => {
  const parked = (id, comments) => issue({
    identifier: id,
    description: 'PARKED: needs a long run, technical.\n' + ARMED,
    state: { name: 'Backlog', type: 'backlog' },
    comments: { nodes: comments },
  });
  const held = parked('BRO-8001', [at('2026-11-01T16:00:00Z', PAUSED_REPORT)]);
  const free = parked('BRO-8002', []);
  const picked = drain.selectDrainCandidates([held, free], { nowMs: NOW }).map((i) => i.identifier);
  assert.ok(!picked.includes('BRO-8001'), `held card must not be selected: ${picked}`);
});
