import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../lib/dispatch-watchdog-core.js');
const { ensureAutoTitle } = require('../lib/workspace-naming.js');

const NOW = Date.parse('2026-08-06T15:00:00Z');
const T = m => new Date(NOW - m * 60000).toISOString();

function task(id, status, priLine) {
  return [String(id), {
    id: String(id), subject: `Fix thing ${id}`, status,
    description: priLine ? `[notion:abc-${id}] ${priLine} · Not started · no-category\nbody` : 'native task',
  }];
}
const titles = pairs => new Map(pairs);
const LIVE = titles([['workspace:1', '🤖⚡ Data·something'], ['workspace:99', '🤖 Site·other']]);

test('ledger-confirmed dead launch with open task is retryable', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '10', subject: 'Fix thing 10', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: '10', workspaceRef: 'workspace:5' },
  ];
  const plan = core.planSweep(entries, new Map([task(10, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 1);
  assert.equal(plan.toDispatch[0].taskId, '10');
});

test('#1154: an owner-judgment card that died is NEVER retried (retry bypasses actionable())', () => {
  // The Sarah check-in shape: launched once, session died, then re-dispatched
  // by dead-session recovery — which goes through `bsc-next --id` and so skips
  // the pick filter entirely. The P0/P1 backlog sweep alone does not cover it.
  const marked = [String(12), {
    id: '12',
    subject: 'Sarah check-in: growth plan progress and metrics report',
    status: 'in_progress',
    description: '[notion:abc-12] P2 Later · Not started · Admin\nDue 2026-05-23. Ask Sarah for status.\n\nVERIFY: owner-judgment (owner must read the report)',
  }];
  const entries = [
    { ts: T(60), event: 'launch', taskId: '12', subject: 'Sarah check-in', workspaceRef: 'workspace:7' },
    { ts: T(30), event: 'dead', taskId: '12', workspaceRef: 'workspace:7' },
  ];
  const plan = core.planSweep(entries, new Map([marked]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 0, 'owner-judgment card must not be retryable');
  assert.equal(plan.toDispatch.filter(d => d.taskId === '12').length, 0, 'and must never be dispatched');

  // Control: identical ledger, identical Admin category, marker removed -> retried.
  const control = [String(12), { ...marked[1], description: marked[1].description.replace(/VERIFY:\s*owner-judgment/i, 'VERIFY: nothing') }];
  const plan2 = core.planSweep(entries, new Map([control]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan2.retryable.length, 1, 'without the marker the same card IS retryable');
});

test('vanished (owner-closed) is never retried — terminal reason matters', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '11', subject: 's', workspaceRef: 'workspace:6' },
    { ts: T(30), event: 'vanished', taskId: '11', workspaceRef: 'workspace:6' },
    { ts: T(29), event: 'dead', taskId: '11', workspaceRef: 'workspace:6' }, // older dead exists too
  ];
  // most recent terminal is 'dead' here — reorder so vanished is last
  entries[1].ts = T(20);
  const plan = core.planSweep(entries, new Map([task(11, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.retryable.length, 0);
  assert.equal(plan.toPark.length, 0);
});

test('completed task is landed — not in flight, not retried', () => {
  const entries = [{ ts: T(60), event: 'launch', taskId: '12', subject: 's', workspaceRef: 'workspace:7' }];
  const plan = core.planSweep(entries, new Map([task(12, 'completed')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.inFlight.length, 0);
  assert.equal(plan.toDispatch.length, 0);
});

test('open launch with open task is in flight; not re-dispatched', () => {
  const entries = [{ ts: T(10), event: 'launch', taskId: '13', subject: 's', workspaceRef: 'workspace:1' }];
  const plan = core.planSweep(entries, new Map([task(13, 'in_progress')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.inFlight.length, 1);
  assert.equal(plan.inFlight[0].listed, true);
  assert.equal(plan.toDispatch.length, 0);
});

test('DEAD_ATTEMPT_LIMIT deaths -> park once; parked card never re-parks or re-dispatches across 100 sweeps (pre-mortem P0)', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: '14', subject: 's', workspaceRef: 'workspace:8' },
    { ts: T(80), event: 'dead', taskId: '14', workspaceRef: 'workspace:8' },
    { ts: T(70), event: 'launch', taskId: '14', subject: 's', workspaceRef: 'workspace:9' },
    { ts: T(60), event: 'dead', taskId: '14', workspaceRef: 'workspace:9' },
  ];
  const tasks = new Map([task(14, 'in_progress')]);
  const first = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
  assert.equal(first.toPark.length, 1, 'first sweep parks');
  assert.equal(first.toDispatch.length, 0);
  // CLI appends the park event; every later sweep must be silent about #14
  entries.push({ ts: T(59), event: core.WATCHDOG_EVENTS.PARK, taskId: '14' });
  for (let i = 0; i < 100; i++) {
    const p = core.planSweep(entries, tasks, { now: NOW, liveTitles: LIVE });
    assert.equal(p.toPark.length, 0, `sweep ${i} re-parked`);
    assert.equal(p.toDispatch.length, 0);
  }
});

test('a fresh launch clears a watchdog park (self-healing, same rule as vanished-park)', () => {
  const entries = [
    { ts: T(90), event: 'launch', taskId: '15', subject: 's', workspaceRef: 'workspace:8' },
    { ts: T(80), event: core.WATCHDOG_EVENTS.PARK, taskId: '15' },
    { ts: T(70), event: 'launch', taskId: '15', subject: 's', workspaceRef: 'workspace:9' },
  ];
  assert.equal(core.watchdogParkedIds(entries).has('15'), false);
});

test('undispatched P0/P1 pending cards queue, P0 first; marketing/human cards excluded', () => {
  const tasks = new Map([
    task(20, 'pending', 'P1 Now'),
    task(19, 'pending', 'P0 Now'),
    ['21', { id: '21', subject: 'Email volunteers', status: 'pending', description: '[notion:x] P1 Now · Not started · Marketing\n' }],
    task(22, 'pending', 'P2 Later'),
  ]);
  const plan = core.planSweep([], tasks, { now: NOW, liveTitles: LIVE });
  assert.deepEqual(plan.p01Queue.map(q => q.taskId), ['19', '20']);
  assert.deepEqual(plan.toDispatch.map(q => q.taskId), ['19', '20']);
});

test('caps: day budget and concurrency hold dispatches and are reported', () => {
  const entries = [];
  for (let i = 0; i < core.CAPS.perDay; i++) {
    entries.push({ ts: new Date(NOW - i * 1000).toISOString(), event: core.WATCHDOG_EVENTS.REDISPATCH, taskId: String(100 + i) });
  }
  const plan = core.planSweep(entries, new Map([task(30, 'pending', 'P1 Now')]), { now: NOW, liveTitles: LIVE });
  assert.equal(plan.toDispatch.length, 0);
  assert.ok(plan.budgets.holds.some(h => h.includes('day budget')));
});

test('cmux unobservable (null or empty listing) = report-only, zero dispatches', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '10', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: '10', workspaceRef: 'workspace:5' },
  ];
  for (const lt of [null, new Map()]) {
    const plan = core.planSweep(entries, new Map([task(10, 'pending')]), { now: NOW, liveTitles: lt });
    assert.equal(plan.cmuxObserved, false);
    assert.equal(plan.toDispatch.length, 0);
    assert.ok(plan.budgets.holds.some(h => h.includes('cmux unobservable')));
  }
});

test('dispatch kill-switch = visibility only', () => {
  const entries = [
    { ts: T(60), event: 'launch', taskId: '10', subject: 's', workspaceRef: 'workspace:5' },
    { ts: T(30), event: 'dead', taskId: '10', workspaceRef: 'workspace:5' },
  ];
  const plan = core.planSweep(entries, new Map([task(10, 'pending')]), { now: NOW, liveTitles: LIVE, dispatchEnabled: false });
  assert.equal(plan.toDispatch.length, 0);
  assert.equal(plan.retryable.length, 1, 'still classified — only the action is held');
});

test('tab title carries counts and the upd HH:MM freshness cue', () => {
  const plan = core.planSweep([], new Map(), { now: NOW, liveTitles: LIVE });
  const title = core.tabTitle(plan);
  assert.match(title, /^👑 OWNER watchdog — 0 in flight · 0 need you · upd \d{2}:\d{2}$/);
});

test('recheck failures count toward needsYou and render in the narrative', () => {
  const plan = core.planSweep([], new Map(), {
    now: NOW, liveTitles: LIVE,
    recheckFailures: [{ notionId: 'n1', taskSubject: 'Broken card', ts: T(60) }],
  });
  assert.equal(plan.needsYou, 1);
  assert.match(core.renderNarrative(plan), /acceptance recheck FAILED/);
});

test('taskPriority parses bridge line and subject fallback', () => {
  assert.equal(core.taskPriority({ description: '[notion:x] P0 Now · In progress · Admin' }), 'P0');
  assert.equal(core.taskPriority({ description: 'native', subject: 'P1: fix it' }), 'P1');
  assert.equal(core.taskPriority({ description: 'native', subject: 'fix it' }), null);
});

test('ensureAutoTitle: bare titles get glyphs, glyphed titles pass through', () => {
  assert.equal(ensureAutoTitle('Fix the thing', 'sonnet'), '🤖⚡ Fix the thing');
  assert.equal(ensureAutoTitle('🤖🧠 Data·already fine', 'fable'), '🤖🧠 Data·already fine');
  assert.equal(ensureAutoTitle('👑 OWNER — mandate', 'opus'), '👑 OWNER — mandate');
  assert.equal(ensureAutoTitle('', 'haiku'), '🤖🪶 untitled dispatch');
});
