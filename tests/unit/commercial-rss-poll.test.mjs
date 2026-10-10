import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-3659 / BRO-3665 — the failure-handling contract of commercial-rss-poll.yml,
 * a CRITICAL hourly cron.
 *
 * Between 2026-09-11 and 2026-09-14 this workflow failed 20 consecutive runs.
 * Every failure had the SAME single cause: the "Commit breaker state" step's
 * push-with-retry.sh call exhausting its local retries AND the Git Data API
 * fallback against transient main-branch ref-update contention (every attempt
 * rc=124 at GIT_NET_TIMEOUT_SEC with zero bytes transferred). Every OTHER step
 * in those same runs succeeded. 02872c7536d (BRO-2524) fixed the blast radius by
 * soft-failing that ONE push. Nothing pinned it, so a future "tighten the error
 * handling" edit could silently reinstate 20 hours of red.
 *
 * BRO-3665 — what that soft-fail UNMASKED (found by a Codex adversarial review of
 * the first draft of this file). Making the push non-fatal turned two pre-existing
 * hazards from "visibly red" into "silently green":
 *
 *   (a) push-with-retry.sh hard-resets the worktree on its conflict-resolution
 *       (~L2008) and pre-API-fallback (~L2274) paths, and nothing in its 2532
 *       lines inspects, stashes or preserves a dirty worktree. The poll step's
 *       output sat UNSTAGED across the breaker push and was destroyed by those
 *       resets. Run 34855723797 is the proof: the poll step SUCCEEDED (so
 *       commercial-rss-state.json WAS written — writeState() is unconditional),
 *       the breaker push hard-reset, and "Commit data changes" then printed
 *       "No changes to commit".
 *   (b) the push in "Commit data changes" lived inside the `else` of
 *       `if git diff --staged --quiet`, so that same run pushed NOTHING at all —
 *       stranding the breaker commit, and with it alert-ledger.json and
 *       breaker-transitions.jsonl (the sole per-day record of which guards
 *       tripped, existing only on the runner disk), on a machine about to be
 *       destroyed.
 *
 * An earlier revision of this file asserted that the breaker commit "rides the
 * later push to main and no state is actually lost". That was FALSE for exactly
 * case (b). It is corrected here rather than pinned.
 *
 * The contract pinned below:
 *   1. the breaker step's push stays soft-failed (contention is transient);
 *   2. its git-add/git-commit stay job-fatal (those would be a real bug);
 *   3. the poll step's output is committed adjacent to its producer, BEFORE any
 *      push-with-retry.sh call in the job can hard-reset it;
 *   4. "Commit data changes" pushes on OUTSTANDING COMMITS, not merely on "this
 *      step staged something", and that push stays job-fatal.
 */

const WORKFLOW = 'commercial-rss-poll.yml';
const JOB = 'poll-and-apply';
const POLL_STEP = 'Poll trade-press RSS';
const POLL_COMMIT_STEP = 'Commit poll output';
const BREAKER_STEP = 'Commit breaker state';
const DATA_STEP = 'Commit data changes';

const stepNames = (doc) => (doc.jobs[JOB].steps || []).map((s) => s.name);
const runOf = (step) => String(step.run || '');

/**
 * A step's `run` script with comment-only lines removed. These steps carry long
 * explanatory comments that name the very commands being asserted on (e.g. a
 * comment citing push-with-retry.sh's own origin/$PULL_BRANCH guard), so every
 * matcher here must look at executable lines only or it matches the prose.
 */
const runCommands = (step) =>
  runOf(step)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

/** The single line in a step's `run` script that invokes push-with-retry.sh. */
function pushLine(step, stepName) {
  const lines = runCommands(step).filter((l) => l.includes('push-with-retry.sh'));
  assert.equal(
    lines.length,
    1,
    `expected exactly one push-with-retry.sh invocation in "${stepName}", found ${lines.length}`,
  );
  return lines[0];
}

test(`${BREAKER_STEP}: its push-with-retry.sh call is soft-failed, not job-fatal (BRO-2524)`, () => {
  const step = findStep(loadWorkflow(WORKFLOW), JOB, BREAKER_STEP);
  assert.match(
    pushLine(step, BREAKER_STEP),
    /push-with-retry\.sh\s*\|\|\s*echo\s+"::warning::/,
    'the breaker-state push must stay soft-failed — BD/SD verdicts are re-derived from the billing APIs next run, '
      + 'and routeAlert() already fired synchronously in the three checks above, so losing this push race must not '
      + 'red the whole hourly cron (20 consecutive failures, 2026-09-11->14)',
  );
});

test(`${BREAKER_STEP}: git add / git commit stay job-fatal (the fix is scoped to the push only)`, () => {
  const step = findStep(loadWorkflow(WORKFLOW), JOB, BREAKER_STEP);
  const guarded = runCommands(step)
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
  // ephemeral runner disk (owner-alert-router.js, card #618 / BRO-3022) and are
  // the sole per-day record of which guards tripped. Dropping either from the
  // git-add line silently loses them for good.
  for (const f of [
    'data/audit/bd-circuit-breaker.json',
    'data/audit/sd-circuit-breaker.json',
    'data/audit/breaker-transitions.jsonl',
    'data/audit/alert-ledger.json',
    'data/audit/alert-digest-queue.json',
  ]) {
    assert.ok(
      runCommands(step).some((l) => l.includes(f)),
      `"${BREAKER_STEP}" must still stage ${f} — it lives only on the runner disk until committed in THIS job`,
    );
  }
});

test(`${POLL_COMMIT_STEP}: commits the poll output and does NOT push (BRO-3665 case (a))`, () => {
  const step = findStep(loadWorkflow(WORKFLOW), JOB, POLL_COMMIT_STEP);
  const run = runCommands(step).join('\n');
  for (const f of ['data/commercial-pending-review.json', 'data/commercial-rss-state.json']) {
    assert.ok(run.includes(f), `"${POLL_COMMIT_STEP}" must stage ${f} before any push can hard-reset it`);
  }
  assert.match(run, /git commit -m/, `"${POLL_COMMIT_STEP}" must actually commit, not just stage`);
  assert.doesNotMatch(
    run,
    /push-with-retry\.sh/,
    `"${POLL_COMMIT_STEP}" must NOT push — "${DATA_STEP}" owns the job-fatal push for this data`,
  );
});

test(`${POLL_COMMIT_STEP} runs AFTER ${POLL_STEP} and BEFORE ${BREAKER_STEP} — the whole point of BRO-3665`, () => {
  const names = stepNames(loadWorkflow(WORKFLOW));
  const poll = names.indexOf(POLL_STEP);
  const commit = names.indexOf(POLL_COMMIT_STEP);
  const breaker = names.indexOf(BREAKER_STEP);
  assert.ok(poll !== -1 && commit !== -1 && breaker !== -1, `all three steps must exist in job "${JOB}"`);
  assert.ok(poll < commit, `"${POLL_COMMIT_STEP}" must run after "${POLL_STEP}" — there is nothing to commit before it`);
  assert.ok(
    commit < breaker,
    `"${POLL_COMMIT_STEP}" must run BEFORE "${BREAKER_STEP}": push-with-retry.sh hard-resets the worktree `
      + `(~L2008, ~L2274) and preserves nothing unstaged, so poll output left uncommitted across that push is `
      + `DESTROYED (run 34855723797). Reordering these reinstates BRO-3665.`,
  );
});

test(`no push-with-retry.sh call may run before ${POLL_COMMIT_STEP}`, () => {
  // Structural form of the invariant, so a NEW step inserted above fails here
  // instead of silently reintroducing the hazard.
  const steps = loadWorkflow(WORKFLOW).jobs[JOB].steps || [];
  const commitIdx = steps.findIndex((s) => s.name === POLL_COMMIT_STEP);
  assert.ok(commitIdx !== -1, `"${POLL_COMMIT_STEP}" must exist`);
  const offenders = steps
    .slice(0, commitIdx)
    .filter((s) => runCommands(s).some((l) => l.includes('push-with-retry.sh')))
    .map((s) => s.name);
  assert.deepEqual(
    offenders,
    [],
    'a push-with-retry.sh call before the poll output is committed will hard-reset it away — '
      + `move the call below "${POLL_COMMIT_STEP}"`,
  );
});

test(`${DATA_STEP}: pushes on OUTSTANDING COMMITS, not only when it staged something (BRO-3665 case (b))`, () => {
  const step = findStep(loadWorkflow(WORKFLOW), JOB, DATA_STEP);
  const run = runCommands(step).join('\n');
  assert.match(
    run,
    /rev-list --count origin\/main\.\.HEAD/,
    `"${DATA_STEP}" must decide whether to push from the job's outstanding commits. When the push sat inside the `
      + '`else` of `if git diff --staged --quiet`, a run that staged nothing here pushed NOTHING, stranding the '
      + 'earlier poll-output and breaker commits on the ephemeral runner (run 34855723797).',
  );
  // The guard must fail OPEN: an unreadable origin/main has to push anyway,
  // never silently skip. `if` suppresses set -e, so an unguarded command
  // substitution would yield empty and skip.
  assert.match(
    run,
    /rev-parse --verify --quiet origin\/main/,
    'the outstanding-commit guard must verify origin/main explicitly and push anyway when it is unreadable — '
      + 'otherwise a missing ref silently skips the push, which is the exact class of loss BRO-3665 fixed',
  );
});

test(`${DATA_STEP}: its push-with-retry.sh call stays job-fatal`, () => {
  const step = findStep(loadWorkflow(WORKFLOW), JOB, DATA_STEP);
  assert.doesNotMatch(
    pushLine(step, DATA_STEP),
    /\|\|/,
    'the primary data push must NOT be soft-failed: it is the only step that lands the poll output AND carries the '
      + 'soft-failed breaker commit to main. Soft-failing it too would make real data loss invisible.',
  );
});

test(`${BREAKER_STEP} runs BEFORE ${DATA_STEP} — the ordering the soft-fail depends on`, () => {
  const names = stepNames(loadWorkflow(WORKFLOW));
  const breakerIdx = names.indexOf(BREAKER_STEP);
  const dataIdx = names.indexOf(DATA_STEP);
  assert.ok(breakerIdx !== -1 && dataIdx !== -1, `both steps must exist in job "${JOB}"`);
  assert.ok(
    breakerIdx < dataIdx,
    `"${BREAKER_STEP}" must precede "${DATA_STEP}": its commit is made locally even when its push is soft-failed, `
      + `and "${DATA_STEP}"'s job-fatal push is what carries that commit to main.`,
  );
});

test(`the three commit steps all run on failure (if: always()) so a failed poll still persists state`, () => {
  const doc = loadWorkflow(WORKFLOW);
  for (const name of [POLL_COMMIT_STEP, BREAKER_STEP, DATA_STEP]) {
    assert.match(
      String(findStep(doc, JOB, name).if || ''),
      /always\(\)/,
      `"${name}" must keep its if: always() guard — a failed step must not strand data on the runner`,
    );
  }
});
