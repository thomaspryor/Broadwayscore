import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  foldAttempts, computeDeadRate, computeDispatchHealthDigest, CMUX_LANE,
} = require('./dispatch-health.js');
// Rule 15: the REAL producer of the shape-1 dead pair, not a hand-copied
// literal — a future change to failedLaunchEntries()'s output shape must fail
// THIS test rather than silently stop being counted.
const { failedLaunchEntries } = require('./dispatch-ledger.js');

const NOW = Date.parse('2026-08-10T12:00:00.000Z'); // window: 2026-08-03T12:00Z →

const launch = (ts, ref, taskId, extra = {}) => ({
  ts, event: 'launch', taskId, subject: `task ${taskId}`, workspaceRef: ref, model: 'sonnet', ...extra,
});
const dead = (ts, ref, taskId, failureReason = 'command injection never ran') => ({
  ts, event: 'dead', taskId, subject: `task ${taskId}`, workspaceRef: ref, failureReason, title: null,
});

// One fixture exercising every shape the real ledger contains. Counts are
// asserted below; the comments give the intended classification of each row.
const FIXTURE = [
  // — out of window (2026-07-20): a dead pair that must NOT reach the window counts
  dead('2026-07-20T10:00:00.000Z', 'workspace:50', '50'),
  launch('2026-07-20T10:00:00.002Z', 'workspace:50', '50', { unverified: true }),

  // — 6 healthy cmux launches (verified, never died)
  launch('2026-08-04T08:00:00.000Z', 'workspace:100', '100'),
  launch('2026-08-04T09:00:00.000Z', 'workspace:101', '101'),
  launch('2026-08-05T08:00:00.000Z', 'workspace:102', '102'),
  launch('2026-08-06T08:00:00.000Z', 'workspace:103', '103'),
  launch('2026-08-07T08:00:00.000Z', 'workspace:104', '104'),
  launch('2026-08-08T08:00:00.000Z', 'workspace:105', '105'),

  // — shape 1: `dead` immediately followed by its own unverified `launch`.
  //   ONE attempt, not two: 1 launch, 1 dead.
  dead('2026-08-05T10:00:00.000Z', 'workspace:200', '200'),
  launch('2026-08-05T10:00:00.002Z', 'workspace:200', '200', { unverified: true }),

  // — shape 2: a normal verified launch, corpse discovered 2.5h later by the
  //   bsc-prune sweep. The death belongs to THAT launch.
  launch('2026-08-06T09:00:00.000Z', 'workspace:201', '201'),
  dead('2026-08-06T11:30:00.000Z', 'workspace:201', '201', 'workspace idle, never booted'),

  // — recycled ref (card #960): workspace:100 launched again days later and
  //   THIS occupant dies. The 08-04 attempt on the same ref must stay alive.
  launch('2026-08-09T08:00:00.000Z', 'workspace:100', '900'),
  dead('2026-08-09T09:00:00.000Z', 'workspace:100', '900', 'workspace idle, never booted'),

  // — deadConfirmed:false (#705 slow boot): unverified launch, deliberately NO
  //   `dead` row. Outcome unknown — must count as `unverified`, never silently
  //   as a healthy launch, and never as a confirmed death.
  launch('2026-08-07T07:00:00.000Z', 'workspace:300', '300', { unverified: true }),

  // — headless job lane: a different failure mechanism, must not dilute the
  //   cmux surface-render rate the card is about.
  launch('2026-08-08T06:00:00.000Z', 'headless:5', '500'),
  dead('2026-08-08T07:00:00.000Z', 'headless:6', '501'),
  launch('2026-08-08T07:00:00.002Z', 'headless:6', '501', { unverified: true }),

  // — a manual, non-cmux-injected launch: neither `workspace:` nor `headless:`
  launch('2026-08-09T13:00:00.000Z', 'live-session-manual', '600'),

  // — a `dead` row whose launch is absent from the input entirely (rotated
  //   ledger). Must be surfaced, never folded into the rate's numerator.
  dead('2026-08-09T12:00:00.000Z', 'workspace:999', '999'),

  // — noise the fold must ignore without crashing
  { ts: '2026-08-08T12:00:00.000Z', event: 'prune-closed', taskId: '105', workspaceRef: 'workspace:105' },
  { ts: '2026-08-08T12:05:00.000Z', event: 'watchdog-redispatch', taskId: '201' },
  { event: 'launch', taskId: 'no-ts', workspaceRef: 'workspace:777' }, // no ts at all
];

test('the ratio: paired dead+launch rows and unpaired successful launches are counted correctly', () => {
  const r = computeDeadRate(FIXTURE, { nowMs: NOW, windowDays: 7 });
  // 6 healthy + shape1 + shape2 + recycled-relaunch + deadConfirmed:false = 10
  assert.equal(r.launches, 10);
  // shape1 (workspace:200) + shape2 (workspace:201) + recycled (workspace:100 @08-09)
  assert.equal(r.dead, 3);
  assert.equal(r.deadRate, 0.3);
  assert.deepEqual(r.deadTaskIds.sort(), ['200', '201', '900']);
});

test('a paired dead+launch is ONE attempt, never two — the pair is not double-counted', () => {
  const onlyThePair = FIXTURE.filter((e) => e.workspaceRef === 'workspace:200');
  assert.equal(onlyThePair.length, 2);
  const r = computeDeadRate(onlyThePair, { nowMs: NOW, windowDays: 7 });
  assert.equal(r.launches, 1);
  assert.equal(r.dead, 1);
  assert.equal(r.deadRate, 1);
});

test('the REAL failedLaunchEntries() output folds to exactly one dead attempt', () => {
  const [deadRow, launchRow] = failedLaunchEntries({
    taskId: '1199', subject: 'x', workspaceRef: 'workspace:295', model: 'opus',
  });
  const entries = [
    { ts: '2026-08-09T10:00:00.000Z', ...deadRow },
    { ts: '2026-08-09T10:00:00.002Z', ...launchRow },
  ];
  const r = computeDeadRate(entries, { nowMs: NOW, windowDays: 7 });
  assert.equal(r.launches, 1, 'failedLaunchEntries() shape must fold to one attempt');
  assert.equal(r.dead, 1);
});

test('a launch that only ever succeeded is never marked dead', () => {
  const r = computeDeadRate([launch('2026-08-06T08:00:00.000Z', 'workspace:103', '103')], {
    nowMs: NOW, windowDays: 7,
  });
  assert.equal(r.launches, 1);
  assert.equal(r.dead, 0);
  assert.equal(r.deadRate, 0);
});

test('a recycled workspaceRef hangs the death on the LATEST launch at or before it, not the first', () => {
  const { attempts } = foldAttempts(FIXTURE);
  const onRef100 = attempts.filter((a) => a.workspaceRef === 'workspace:100');
  assert.equal(onRef100.length, 2);
  assert.equal(onRef100[0].taskId, '100');
  assert.equal(onRef100[0].dead, false, 'the earlier occupant of a recycled ref must stay alive');
  assert.equal(onRef100[1].taskId, '900');
  assert.equal(onRef100[1].dead, true);
});

test('deadConfirmed:false (unverified, no dead row) is its own state — not dead, not healthy', () => {
  const r = computeDeadRate(FIXTURE, { nowMs: NOW, windowDays: 7 });
  assert.equal(r.unverified, 1);
  assert.ok(!r.deadTaskIds.includes('300'), 'an unconfirmed slow boot is not a confirmed death');
  assert.deepEqual(r.unverifiedTaskIds, ['300']);
});

test('the headless job lane is visible in byLane but excluded from the cmux paging rate', () => {
  const r = computeDeadRate(FIXTURE, { nowMs: NOW, windowDays: 7 });
  assert.equal(r.lane, CMUX_LANE);
  // headless:6's unverified launch is CLAIMED by its paired dead row, so it
  // counts as a confirmed death, not an open question.
  assert.deepEqual(r.byLane.headless, { launches: 2, dead: 1, unverified: 0 });
  assert.deepEqual(r.byLane.workspace, { launches: 10, dead: 3, unverified: 1 });
  // a ref with no "prefix:" shape still lands somewhere — never silently dropped
  assert.deepEqual(r.byLane.other, { launches: 1, dead: 0, unverified: 0 });
  const total = Object.values(r.byLane).reduce((n, v) => n + v.launches, 0);
  assert.equal(total, 13, 'every in-window launch must appear in exactly one lane');
});

test('launches outside the window are excluded from both numerator and denominator', () => {
  const wide = computeDeadRate(FIXTURE, { nowMs: NOW, windowDays: 30 });
  assert.equal(wide.launches, 11, 'the 2026-07-20 attempt joins a 30-day window');
  assert.equal(wide.dead, 4);
});

test('a dead row with no launch in the input is surfaced, never folded into the rate', () => {
  const r = computeDeadRate(FIXTURE, { nowMs: NOW, windowDays: 7 });
  assert.equal(r.unattributedDeadCount, 1);
  assert.ok(!r.deadTaskIds.includes('999'));
});

test('computeDeadRate refuses to invent a clock', () => {
  assert.throws(() => computeDeadRate(FIXTURE, {}), /nowMs/);
  assert.throws(() => computeDeadRate(FIXTURE), /nowMs/);
});

test('digest pages (error) when the rate is over the floor on a large enough sample', () => {
  const row = computeDispatchHealthDigest({
    entries: FIXTURE, nowMs: NOW, windowDays: 7, deadRateFloor: 0.10, minLaunches: 5,
  });
  assert.equal(row.status, 'error');
  assert.match(row.message, /30%/);
  assert.match(row.message, /3\/10/);
  assert.ok(row.hint, 'a paging row must tell the owner what to do');
});

test('digest does not page on a sample too small to read a rate off', () => {
  const row = computeDispatchHealthDigest({
    entries: FIXTURE, nowMs: NOW, windowDays: 7, deadRateFloor: 0.10, minLaunches: 20,
  });
  assert.equal(row.status, 'warn');
  assert.match(row.message, /minimum/);
});

test('digest passes when the rate is at or under the floor', () => {
  const healthy = [];
  for (let i = 0; i < 20; i++) healthy.push(launch(`2026-08-0${(i % 5) + 4}T0${i % 10}:00:00.000Z`, `workspace:${400 + i}`, String(400 + i)));
  healthy.push(dead('2026-08-08T05:00:00.000Z', 'workspace:420', '420'));
  healthy.push(launch('2026-08-08T05:00:00.002Z', 'workspace:420', '420', { unverified: true }));
  const row = computeDispatchHealthDigest({ entries: healthy, nowMs: NOW, windowDays: 7 });
  assert.equal(row.status, 'pass');
  assert.equal(row.dead, 1);
  assert.equal(row.launches, 21);
});

test('an empty ledger warns "cannot measure" — never a vacuous pass', () => {
  const row = computeDispatchHealthDigest({ entries: [], nowMs: NOW, windowDays: 7 });
  assert.equal(row.status, 'warn');
  assert.match(row.message, /cannot be measured|No dispatch launches/);
  assert.notEqual(row.status, 'pass');
});

test('the digest row is shaped for health-check.js (name/status/message)', () => {
  const row = computeDispatchHealthDigest({ entries: FIXTURE, nowMs: NOW, windowDays: 7, minLaunches: 5 });
  assert.equal(typeof row.name, 'string');
  assert.ok(['pass', 'warn', 'error'].includes(row.status));
  assert.equal(typeof row.message, 'string');
});
