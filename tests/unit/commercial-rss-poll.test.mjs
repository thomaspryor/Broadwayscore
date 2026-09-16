import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3659 — regression test for BRO-2524, which shipped without one.
 *
 * Between 2026-09-11 and 2026-09-14 this hourly cron failed 20 consecutive
 * runs. Every single failure had the SAME single cause: the "Commit breaker
 * state" step's push-with-retry.sh call exhausting its local retries AND the
 * Git Data API fallback against transient main-branch ref-update contention
 * (every attempt rc=124 at GIT_NET_TIMEOUT_SEC with zero bytes transferred).
 * Every OTHER step in those same runs succeeded — including the LATER "Commit
 * data changes" push to main moments afterwards — so the poller's actual
 * function (poll, auto-apply, core-data push, deploy) worked every hour while
 * the job reported failed, which is what fed the chronic-stale/repeat-failure
 * conditions.
 *
 * 02872c7536d (BRO-2524) fixed the blast radius by soft-failing that ONE push
 * call. Nothing pinned it, so a future "tighten the error handling" edit could
 * silently reinstate 20 hours of red. This file pins the whole failure-handling
 * contract of that fix, including the three invariants that make the soft-fail
 * SAFE rather than lossy:
 *
 *   1. The breaker step's push is soft-failed (contention is transient).
 *   2. Its git-add/git-commit stay job-fatal (those would be a real bug).
 *   3. "Commit data changes" runs LATER and its push stays job-fatal — so the
 *      soft-failed step's local commit rides that push to main and no
 *      alert-ledger / breaker-transitions state is actually lost; only its
 *      arrival on main is delayed. (push-with-retry.sh captures its own
 *      SCRIPT_ENTRY_HEAD per invocation, so the second call's diff already
 *      contains the first call's commit.)
 */

const WORKFLOW = 'commercial-rss-poll.yml';
const JOB = 'poll-and-apply';
const BREAKER_STEP = 'Commit breaker state';
const DATA_STEP = 'Commit data changes';

/** The single line in a step's `run` script that invokes push-with-retry.sh. */
function pushLine(step, stepName) {
  const lines = String(step.run || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('push-with-retry.sh'));
  assert.equal(
    lines.length,
    1,
    `expected exactly one push-with-retry.sh invocation in "${stepName}", found ${lines.length}`,
  );
  return lines[0];
}

test(`${BREAKER_STEP}: its push-with-retry.sh call is soft-failed, not job-fatal (BRO-2524)`, () => {
  const step = findStep(loadWorkflow(WORKFLOW), JOB, BREAKER_STEP);
  const line = pushLine(step, BREAKER_STEP);
  assert.match(
    line,
    /push-with-retry\.sh\s*\|\|\s*echo\s+"::warning::/,
    'the breaker-state push must stay soft-failed — BD/SD verdicts are re-derived from the billing APIs next run, '
      + 'and routeAlert() already fired synchronously in the three checks above, so losing this push race must not '
      + 'red the whole hourly cron (20 consecutive failures, 2026-09-11->14)',
  );
});

test(`${BREAKER_STEP}: git add / git commit stay job-fatal (the fix is scoped to the push only)`, () => {
  const step = findStep(loadWorkflow(WORKFLOW), JOB, BREAKER_STEP);
  const guarded = String(step.run || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(bash scripts\/lib\/git-add-existing\.sh|git commit )/.test(l))
    .filter((l) => /\|\||\btrue\b\s*$/.test(l));
  assert.deepEqual(
    guarded,
    [],
    'a git-add/git-commit failure here means a real script/data bug, not push contention — it must still red the job',
  );
});

test(`${BREAKER_STEP}: still stages the runner-only alert state it is hosted here to persist`, () => {
  const step = findStep(loadWorkflow(WORKFLOW), JOB, BREAKER_STEP);
  // alert-ledger.json and breaker-transitions.jsonl exist ONLY on this job's
  // ephemeral runner disk (owner-alert-router.js, card #618 / BRO-3022) and
  // are the sole per-day record of which guards tripped. Dropping either from
  // the git-add line silently loses them for good.
  for (const f of [
    'data/audit/bd-circuit-breaker.json',
    'data/audit/sd-circuit-breaker.json',
    'data/audit/breaker-transitions.jsonl',
    'data/audit/alert-ledger.json',
    'data/audit/alert-digest-queue.json',
  ]) {
    assert.ok(
      String(step.run || '').includes(f),
      `"${BREAKER_STEP}" must still stage ${f} — it lives only on the runner disk until committed in THIS job`,
    );
  }
});

test(`${DATA_STEP}: its push-with-retry.sh call stays job-fatal`, () => {
  const step = findStep(loadWorkflow(WORKFLOW), JOB, DATA_STEP);
  const line = pushLine(step, DATA_STEP);
  assert.doesNotMatch(
    line,
    /\|\|/,
    'the primary data push must NOT be soft-failed: it is the step that actually lands commercial-pending-review.json '
      + 'AND carries the soft-failed breaker commit to main. Soft-failing it too would make real data loss invisible.',
  );
});

test(`${BREAKER_STEP} runs BEFORE ${DATA_STEP} — the ordering is what makes the soft-fail non-lossy`, () => {
  const doc = loadWorkflow(WORKFLOW);
  const steps = (doc.jobs[JOB].steps || []).map((s) => s.name);
  const breakerIdx = steps.indexOf(BREAKER_STEP);
  const dataIdx = steps.indexOf(DATA_STEP);
  assert.ok(breakerIdx !== -1 && dataIdx !== -1, `both steps must exist in job "${JOB}"`);
  assert.ok(
    breakerIdx < dataIdx,
    `"${BREAKER_STEP}" must precede "${DATA_STEP}": its commit is made locally even when its push is soft-failed, `
      + `and the later job-fatal push is what carries that commit to main. Reversing them would turn every soft-failed `
      + `breaker push into permanent loss of breaker-transitions.jsonl.`,
  );
});

test(`${BREAKER_STEP} and ${DATA_STEP} both run on failure (if: always()) so a failed poll still persists state`, () => {
  const doc = loadWorkflow(WORKFLOW);
  for (const name of [BREAKER_STEP, DATA_STEP]) {
    const step = findStep(doc, JOB, name);
    assert.match(
      String(step.if || ''),
      /always\(\)/,
      `"${name}" must keep its if: always() guard — a failed poll step must not strand breaker/alert state on the runner`,
    );
  }
});
