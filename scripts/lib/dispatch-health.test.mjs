import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  foldAttempts, computeDeadRate, computeDispatchHealthDigest, computeHeadlessDispatchDigest, CMUX_LANE,
} = require('./dispatch-health.js');
const { JOB_EVENTS } = require('./dispatch-ledger.js');
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

// Ship-check finding: after a cmux restart, dispatch-ledger rewrites a live
// dispatch onto a NEW ref and journals {event:'remapped', workspaceRef:<old>,
// newRef:<new>}. Real shape from the ledger (task #895, 2026-08-03): the old
// launch is unverified:true (verification is what gave up when cmux
// restarted), and the relaunch is a separate launch row. Counting both
// inflates the denominator AND invents an "unverified" attempt for a dispatch
// that actually continued.
const REMAPPED_895 = [
  launch('2026-08-05T01:00:29.409Z', 'workspace:57', '895', { unverified: true }),
  { ts: '2026-08-05T03:43:04.110Z', event: 'remapped', taskId: '895', workspaceRef: 'workspace:57', newRef: 'workspace:73' },
  launch('2026-08-05T03:43:04.200Z', 'workspace:73', '895'),
];

test('a remapped dispatch is ONE attempt, not two — the superseded launch drops out', () => {
  const r = computeDeadRate(REMAPPED_895, { nowMs: NOW, windowDays: 7 });
  assert.equal(r.launches, 1, 'the pre-restart launch and its relaunch are the same real dispatch');
  assert.equal(r.supersededByRemapCount, 1);
  assert.equal(r.unverified, 0, 'the pre-restart unverified flag must not survive as a phantom unknown');
  assert.equal(r.dead, 0);
});

test('remap supersession is last-match-at-or-before, so it cannot swallow a LATER reuse of the old ref', () => {
  const entries = [
    ...REMAPPED_895,
    // workspace:57 recycled onto a different task days later — untouched by
    // the older remap (card #960's recycled-ref rule, restated for remaps).
    launch('2026-08-08T10:00:00.000Z', 'workspace:57', '999'),
  ];
  const r = computeDeadRate(entries, { nowMs: NOW, windowDays: 7 });
  assert.equal(r.launches, 2);
  assert.equal(r.supersededByRemapCount, 1);
  const { attempts } = foldAttempts(entries);
  assert.ok(attempts.some((a) => a.taskId === '999'), 'the later occupant of a recycled ref must survive');
});

test('a remapped row with no matching launch is ignored, not a crash', () => {
  const orphanRemap = [{ ts: '2026-08-06T00:00:00.000Z', event: 'remapped', taskId: '5', workspaceRef: 'workspace:404', newRef: 'workspace:405' }];
  const r = computeDeadRate(orphanRemap, { nowMs: NOW, windowDays: 7 });
  assert.equal(r.launches, 0);
  assert.equal(r.supersededByRemapCount, 0);
});

// Adversarial review of the FIRST cut of the remap fix caught this: the
// supersession loop matched "last launch at-or-before the remap" with no
// regard for whether that launch had already DIED. Real shape from the
// ledger (task #925): the only launch on workspace:99 is a confirmed
// shape-1 death ("command injection never ran"), and a remapped row for the
// same ref lands NINE HOURS later — erasing a real death from both `dead`
// and `deadTaskIds`, i.e. undercounting the exact metric this card exists
// to protect. Superseding means "this dispatch continued under a new ref",
// which a corpse by definition did not do.
const REMAPPED_OVER_A_CORPSE_925 = [
  dead('2026-08-05T04:55:39.230Z', 'workspace:99', '925'),
  launch('2026-08-05T04:55:39.231Z', 'workspace:99', '925', { unverified: true }),
  { ts: '2026-08-05T13:52:30.047Z', event: 'remapped', taskId: '925', workspaceRef: 'workspace:99', newRef: 'workspace:105' },
  launch('2026-08-05T13:52:30.100Z', 'workspace:105', '925'),
];

test('a remap NEVER supersedes a confirmed-dead attempt — the death still counts', () => {
  const r = computeDeadRate(REMAPPED_OVER_A_CORPSE_925, { nowMs: NOW, windowDays: 7 });
  assert.equal(r.dead, 1, 'the workspace:99 corpse must survive the remap');
  assert.deepEqual(r.deadTaskIds, ['925']);
  assert.equal(r.launches, 2, 'both the dead attempt and the fresh relaunch count');
  assert.equal(r.supersededByRemapCount, 0, 'nothing was legitimately superseded here');
  const { attempts } = foldAttempts(REMAPPED_OVER_A_CORPSE_925);
  assert.ok(attempts.some((a) => a.workspaceRef === 'workspace:99' && a.dead),
    'the dead attempt must remain in the fold, not be filtered out');
});

test('supersededByRemapCount is window-scoped like every other figure on the row', () => {
  // The superseded launch sits OUTSIDE a 7-day window anchored at NOW; a
  // lifetime total would report 1 here and silently stop reconciling with
  // the windowed `launches` it is meant to explain.
  const old = [
    launch('2026-06-01T01:00:00.000Z', 'workspace:57', '895', { unverified: true }),
    { ts: '2026-06-01T03:00:00.000Z', event: 'remapped', taskId: '895', workspaceRef: 'workspace:57', newRef: 'workspace:73' },
    launch('2026-06-01T03:00:01.000Z', 'workspace:73', '895'),
  ];
  const narrow = computeDeadRate(old, { nowMs: NOW, windowDays: 7 });
  assert.equal(narrow.launches, 0);
  assert.equal(narrow.supersededByRemapCount, 0, 'out-of-window supersession must not leak into a 7d row');
  const wide = computeDeadRate(old, { nowMs: NOW, windowDays: 120 });
  assert.equal(wide.launches, 1);
  assert.equal(wide.supersededByRemapCount, 1);
});

// ── computeHeadlessDispatchDigest (card #1714) ──────────────────────────────
// Same NOW anchor; window is 14d by default here, so 2026-07-27T12:00Z →.

const hlLaunch = (ts, taskId) => ({ ts, event: 'launch', taskId, workspaceRef: `headless:${taskId}` });
const hlSpawn = (ts, taskId, jobId) => ({ ts, event: JOB_EVENTS.SPAWNED, taskId, jobId });
const hlDone = (ts, taskId, jobId) => ({ ts, event: JOB_EVENTS.DONE, taskId, jobId });
const hlFailed = (ts, taskId, jobId) => ({ ts, event: JOB_EVENTS.FAILED, taskId, jobId });

function headlessRun(taskId, launchTs, outcome) {
  const jobId = `j-${taskId}`;
  const spawnTs = new Date(Date.parse(launchTs) + 1000).toISOString();
  const rows = [hlLaunch(launchTs, taskId), hlSpawn(spawnTs, taskId, jobId)];
  if (outcome === 'done' || outcome === 'failed') {
    const termTs = new Date(Date.parse(launchTs) + 60000).toISOString();
    rows.push((outcome === 'done' ? hlDone : hlFailed)(termTs, taskId, jobId));
  }
  return rows;
}

test('headless digest passes when the success rate is at or over the floor', () => {
  const entries = [];
  for (let i = 0; i < 9; i++) entries.push(...headlessRun(`h-ok-${i}`, `2026-08-0${(i % 5) + 1}T00:0${i}:00.000Z`, 'done'));
  entries.push(...headlessRun('h-bad-0', '2026-08-05T00:00:00.000Z', 'failed'));
  const row = computeHeadlessDispatchDigest({ entries, nowMs: NOW });
  assert.equal(row.status, 'pass');
  assert.equal(row.resolved, 10);
  assert.equal(row.done, 9);
});

test('headless digest warns "cannot measure" on zero resolved launches — never a vacuous pass', () => {
  const entries = [...headlessRun('h-inflight', '2026-08-05T00:00:00.000Z', 'inFlight')];
  const row = computeHeadlessDispatchDigest({ entries, nowMs: NOW });
  assert.equal(row.status, 'warn');
  assert.match(row.message, /cannot be measured/);
  assert.notEqual(row.status, 'pass');
});

test('headless digest warns (not errors) when under the floor but the sample is too small', () => {
  const entries = [...headlessRun('h-bad-1', '2026-08-05T00:00:00.000Z', 'failed'), ...headlessRun('h-bad-2', '2026-08-06T00:00:00.000Z', 'failed')];
  const row = computeHeadlessDispatchDigest({ entries, nowMs: NOW, minResolved: 10 });
  assert.equal(row.status, 'warn');
  assert.match(row.message, /minimum/);
});

test('headless digest errors when under the floor on a large enough sample', () => {
  const entries = [];
  for (let i = 0; i < 8; i++) entries.push(...headlessRun(`h-fail-${i}`, `2026-08-0${(i % 5) + 1}T0${i}:00:00.000Z`, 'failed'));
  for (let i = 0; i < 2; i++) entries.push(...headlessRun(`h-ok-${i}`, `2026-08-0${i + 6}T00:00:00.000Z`, 'done'));
  const row = computeHeadlessDispatchDigest({ entries, nowMs: NOW, minResolved: 10 });
  assert.equal(row.status, 'error');
  assert.equal(row.resolved, 10);
  assert.equal(row.failed, 8);
  assert.match(row.message, /20%/);
  assert.ok(row.hint, 'a paging row must tell the owner what to do');
});

test('the headless digest row is shaped for health-check.js (name/status/message)', () => {
  const entries = [...headlessRun('h-x', '2026-08-05T00:00:00.000Z', 'done')];
  const row = computeHeadlessDispatchDigest({ entries, nowMs: NOW, minResolved: 1 });
  assert.equal(typeof row.name, 'string');
  assert.equal(row.name, 'Headless dispatch: success rate');
  assert.ok(['pass', 'warn', 'error'].includes(row.status));
  assert.equal(typeof row.message, 'string');
});

// ── Task #1904: a recycled ref must not resurrect a finished attempt ───────

test('a dead row arriving AFTER the launch was reconciled belongs to the ref\'s next occupant, not to it', () => {
  // The live 2026-08-26 shape: #1888 launched into workspace:46, finished and
  // was prune-closed, and hours later a sweep found workspace:46 — by then a
  // completely different tab — idle and wrote a `dead` row naming #1888.
  // Counting that as a death makes a SUCCESSFUL dispatch read as a failure.
  const entries = [
    launch('2026-08-08T04:20:00.000Z', 'workspace:46', '1888'),
    { ts: '2026-08-08T05:16:00.000Z', event: 'prune-closed', taskId: '1888', workspaceRef: 'workspace:46' },
    dead('2026-08-08T13:19:00.000Z', 'workspace:46', '1888'),
  ];
  const folded = foldAttempts(entries);
  assert.equal(folded.attempts.length, 1);
  assert.equal(folded.attempts[0].dead, false, 'the finished dispatch must not be counted dead');
  assert.equal(folded.unattributedDeadCount, 1, 'the death is surfaced as unattributed, never silently dropped');

  const r = computeDeadRate(entries, { nowMs: Date.parse('2026-08-10T12:00:00.000Z'), windowDays: 7 });
  assert.deepEqual([r.launches, r.dead, r.deadRate], [1, 0, 0]);
});

test('a no-payload death is NOT disowned by the reconciling rule — that reaper closed the tab itself', () => {
  // /code-review finding 6, decided deliberately. bsc-prune's no-payload
  // reaper is the ONE dead-row writer that closes the workspace and then
  // journals the death, so its own close can leave a prune-closed row on the
  // ref ahead of its own `dead` row. Everything else that matches this shape
  // is cmux recycling a ref (measured: every currently-excluded row has a
  // launch-to-death gap of 9 hours to 31 days).
  const folded = foldAttempts([
    { ts: '2026-08-08T04:18:00.000Z', event: 'launch', taskId: '1901', workspaceRef: 'workspace:70' },
    { ts: '2026-08-08T05:00:00.000Z', event: 'prune-closed', taskId: '1901', workspaceRef: 'workspace:70' },
    { ts: '2026-08-08T05:00:01.000Z', event: 'dead', taskId: '1901', workspaceRef: 'workspace:70', reason: 'no-payload' },
  ]);
  assert.equal(folded.attempts[0].dead, true, 'a never-booted tab the reaper closed IS a real death');
  assert.equal(folded.unattributedDeadCount, 0);
});

test('an ordinary shape-2 breadcrumb (no reconciling event in between) still counts as a death', () => {
  // The guard must not swallow the real case it sits next to: a verified
  // launch that a later sweep finds dead, with nothing in between.
  const entries = [
    launch('2026-08-08T04:20:00.000Z', 'workspace:47', '1889'),
    dead('2026-08-08T13:19:00.000Z', 'workspace:47', '1889'),
  ];
  const folded = foldAttempts(entries);
  assert.equal(folded.attempts[0].dead, true);
  assert.equal(folded.unattributedDeadCount, 0);
});

test('a reconciling event BEFORE the launch cannot suppress that launch\'s own death', () => {
  // Ordering matters: the prune-closed here belongs to the ref's PREVIOUS
  // occupant, so the fresh launch after it is still fully accountable.
  const entries = [
    launch('2026-08-04T01:00:00.000Z', 'workspace:48', '900'),
    { ts: '2026-08-04T02:00:00.000Z', event: 'prune-closed', taskId: '900', workspaceRef: 'workspace:48' },
    launch('2026-08-08T04:00:00.000Z', 'workspace:48', '901'),
    dead('2026-08-08T05:00:00.000Z', 'workspace:48', '901'),
  ];
  const folded = foldAttempts(entries);
  const latest = folded.attempts.find((a) => a.taskId === '901');
  assert.equal(latest.dead, true, 'the newer attempt has no reconciling event after it — its death stands');
  assert.equal(folded.attempts.find((a) => a.taskId === '900').dead, false);
});

test('a shape-1 pair is immune to the reconciling rule — the death IS this launch', () => {
  // The paired row is written by the launcher at failure time, 1-2ms apart, so
  // a stale prune-closed on a recycled ref must not disarm it.
  const entries = [
    launch('2026-08-04T01:00:00.000Z', 'workspace:49', '910'),
    { ts: '2026-08-04T02:00:00.000Z', event: 'prune-closed', taskId: '910', workspaceRef: 'workspace:49' },
    dead('2026-08-08T06:00:00.000Z', 'workspace:49', '911'),
    launch('2026-08-08T06:00:00.002Z', 'workspace:49', '911', { unverified: true }),
  ];
  const folded = foldAttempts(entries);
  assert.equal(folded.attempts.find((a) => a.taskId === '911').dead, true);
  assert.equal(folded.unattributedDeadCount, 0);
});
