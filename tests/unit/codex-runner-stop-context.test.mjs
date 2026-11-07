import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runnerTimeLimits, runnerLockBody, lockRun, lockCards, lockMessage, orphanStopDetails, slotArgs, landWaitMinutes } = require('../../scripts/lib/codex-runner.js');

test('bare cloud launches finish before the 120-minute host limit', () => {
  assert.deepEqual(runnerTimeLimits(), { maxMinutes: 105, hardStopMinutes: 112 });
  assert.deepEqual(runnerTimeLimits({ maxMinutes: 420 }), { maxMinutes: 420, hardStopMinutes: 112 });
});

test('GHA and explicit launch limits retain their budgets', () => {
  assert.deepEqual(runnerTimeLimits({ lane: 'gha' }), { maxMinutes: 240, hardStopMinutes: 290 });
  assert.deepEqual(runnerTimeLimits({ lane: 'gha', maxMinutes: '210', hardStopMinutes: '290' }), { maxMinutes: 210, hardStopMinutes: 290 });
  assert.deepEqual(runnerTimeLimits({ maxMinutes: '105', hardStopMinutes: '112' }), { maxMinutes: 105, hardStopMinutes: 112 });
  for (const hardStopMinutes of [0, true, 'oops', Infinity, 29]) assert.throws(() => runnerTimeLimits({ hardStopMinutes }), /hard-stop-minutes/);
  for (const maxMinutes of [0, -1, 'oops', Infinity]) assert.throws(() => runnerTimeLimits({ maxMinutes }), /max-minutes/);
});

test('PR launches without time flags retain the full landing wait after slow checks', () => {
  for (const lane of ['cloud', 'gha']) {
    const limits = runnerTimeLimits({ lane, pr: 123 });
    assert.equal(limits.hardStopMinutes, 0);
    const hardEndMs = limits.hardStopMinutes > 0 ? limits.hardStopMinutes * 60_000 : Infinity;
    for (const elapsedMinutes of [100, 200]) {
      assert.equal(landWaitMinutes({ hardEndMs, wrapUpMs: 8 * 60_000, nowMs: elapsedMinutes * 60_000 }), 90);
    }
  }
  assert.deepEqual(runnerTimeLimits({ pr: 123, maxMinutes: '210' }), { maxMinutes: 210, hardStopMinutes: 0 });
});

test('PR launches honor explicit hard stops and reject invalid time flags', () => {
  const limits = runnerTimeLimits({ pr: 123, maxMinutes: '105', hardStopMinutes: '112' });
  assert.deepEqual(limits, { maxMinutes: 105, hardStopMinutes: 112 });
  assert.equal(landWaitMinutes({ hardEndMs: limits.hardStopMinutes * 60_000, wrapUpMs: 8 * 60_000, nowMs: 100 * 60_000 }), 4);
  assert.equal(runnerTimeLimits({ lane: 'gha', pr: 123, hardStopMinutes: '290' }).hardStopMinutes, 290);
  for (const hardStopMinutes of [0, true, 'oops', Infinity, 29]) assert.throws(() => runnerTimeLimits({ pr: 123, hardStopMinutes }), /hard-stop-minutes/);
  for (const maxMinutes of [0, -1, 'oops', Infinity]) assert.throws(() => runnerTimeLimits({ pr: 123, maxMinutes }), /max-minutes/);
});

test('slot launch arguments preserve the original launch time and hard stop', () => {
  const argv = slotArgs(['--slots', '3', '--hard-stop-minutes', '112'], { slot: 2, runDir: '', runStartedMs: 123, limit: 3, checkBudgetUsd: 10 });
  assert.equal(argv[argv.indexOf('--hard-stop-minutes') + 1], '112');
  assert.equal(argv[argv.indexOf('--run-started') + 1], '123');
});

test('durable lock context retains the owner and records the last phase and deadline', () => {
  const startedMs = Date.parse('2026-10-22T00:00:00Z');
  const hardEndMs = startedMs + 112 * 60_000;
  const body = runnerLockBody({ run: 'session/123', startedMs, hardEndMs, phase: 'codex' });
  assert.equal(lockRun(body), 'session/123');
  assert.deepEqual(lockCards(lockMessage('2026-10-22T01:00:00Z', ['BRO-4305'])), ['BRO-4305']);
  const details = orphanStopDetails({ body, run: lockRun(body), ms: startedMs + 60 * 60_000 });
  assert.match(details, /unreported session termination/);
  assert.match(details, /Previous run: session\/123/);
  assert.match(details, /Started: 2026-10-22T00:00:00.000Z/);
  assert.match(details, /Last recorded phase: codex/);
  assert.match(details, /Configured hard stop: 2026-10-22T01:52:00.000Z/);
  assert.doesNotMatch(details, /still active/);
  assert.match(orphanStopDetails({ body, ms: hardEndMs }), /still active at or beyond its hard stop/);
});

test('old locks and released locks never fabricate a termination cause', () => {
  assert.match(orphanStopDetails({ body: 'Run: old/123', run: 'old/123' }), /Last recorded phase: not recorded/);
  assert.match(orphanStopDetails(), /Configured hard stop: not recorded/);
  const released = orphanStopDetails({ subject: 'released 2026-10-22T01:00:00Z cards=BRO-4305', body: 'Run: old/123' });
  assert.match(released, /released its lock with unfinished cards/);
  assert.doesNotMatch(released, /unreported session termination/);
});
