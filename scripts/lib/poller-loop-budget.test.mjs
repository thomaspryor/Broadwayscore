import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { loadWorkflow, findStep } from '../../tests/helpers/workflow-push-timeout.mjs';
const { rotateShows, showTimeoutSec } = createRequire(import.meta.url)('./poller-loop-budget.js');

test('rotateShows rotates by seed, wraps, drops empties', () => {
  assert.deepEqual(rotateShows(['a', 'b', 'c'], 0), ['a', 'b', 'c']);
  assert.deepEqual(rotateShows(['a', 'b', 'c'], 4), ['b', 'c', 'a']);
  assert.deepEqual(rotateShows(['a', '', 'b'], 1), ['b', 'a']);
  assert.deepEqual(rotateShows([], 3), []);
  // priority head is never rotated
  assert.deepEqual(rotateShows(['n1', 'n2', 'a', 'b', 'c'], 1, 2), ['n1', 'n2', 'b', 'c', 'a']);
  assert.deepEqual(rotateShows(['n1', 'n2'], 5, 8), ['n1', 'n2']);
  assert.deepEqual(rotateShows(['a', 'b'], 'x'), ['a', 'b']);
});

test('showTimeoutSec caps per show, clamps to remaining, stops when too little left', () => {
  assert.equal(showTimeoutSec(4000), 600);
  assert.equal(showTimeoutSec(300), 300);
  assert.equal(showTimeoutSec(239), 0);
  assert.equal(showTimeoutSec(240), 240);
  assert.equal(showTimeoutSec(-5), 0);
  assert.equal(showTimeoutSec(NaN), 0);
});

test('CLI matches the functions', () => {
  const run = (...a) => execFileSync('node', ['scripts/lib/poller-loop-budget.js', ...a], { encoding: 'utf8' }).trim();
  assert.equal(run('rotate', 'a,b,c', '1'), 'b,c,a');
  assert.equal(run('timeout', '300'), '300');
  assert.equal(run('timeout', '50'), '0');
  assert.equal(run('rotate', 'n,a,b,c', '1', '1'), 'n,b,c,a');
});

test('poller loop is budgeted; budget + pre-loop setup leave room for the post-poll stages inside the job timeout', () => {
  const wf = loadWorkflow('opening-night-poller.yml');
  const step = findStep(wf, 'poll', 'Run poller for each show');
  const budget = Number(step.env.POLL_LOOP_BUDGET_SEC);
  assert.ok(budget > 0, 'POLL_LOOP_BUDGET_SEC must be set');
  const jobSec = wf.jobs.poll['timeout-minutes'] * 60;
  // pre-loop (checkout, installs, drain <=8 min) ~ 20 min worst case; post-loop
  // collect 12 + score ~10 + fast_path rebuild 15 + deploy wait 9 + rest ~ 55 min.
  assert.ok(jobSec - 20 * 60 - budget >= 55 * 60, `loop budget ${budget}s leaves too little of the ${jobSec}s job`);
  assert.match(step.run, /poller-loop-budget\.js timeout/);
  assert.match(step.run, /poller-loop-budget\.js rotate/);
  assert.match(step.run, /SKIPPED_SHOWS="\$SKIPPED_SHOWS \$SHOW_ID"\n\s+continue/);
  assert.ok(Number(step.env.POLL_PRIORITY_SHOWS) > 0);
  assert.match(step.run, /poller-loop-budget\.js rotate .*POLL_PRIORITY_SHOWS/);
  assert.match(step.run, /POLLER_RC" -eq 124/);
  // GATHER_TOTAL must only count shows actually polled (after the budget check)
  assert.ok(step.run.indexOf('\n              continue') < step.run.indexOf('GATHER_TOTAL=$((GATHER_TOTAL + 1))'));
});
