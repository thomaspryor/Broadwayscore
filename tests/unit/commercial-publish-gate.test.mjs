import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'commercial-weekly.yml');

/**
 * BRO-2907. In `commercial-weekly.yml`'s `auto-apply` job, three steps mutate
 * commercial data (auto-apply, the recoupment reconciler, the dedupe
 * self-heal) and a strict gate judges the result. All of them are
 * success()-gated, because a step with no `if:` defaults to `if: success()`.
 * The commit, the private-repo push and the deploy dispatch were all
 * `if: always()`. So ANY failure among the mutators skipped the gate — the
 * only thing that wrote the push-core-data refusal sentinel and restored the
 * mutated files — while the always()-gated steps published anyway. That
 * shipped half-mutated commercial data AND recorded the pending entries as
 * consumed, so the next weekly run could not retry them.
 *
 * The fix is a single fail-closed barrier (`id: commit-gate`) that runs
 * `if: always()`, refuses on `job.status != 'success'`, and which every
 * publishing step keys off. This test pins that shape.
 *
 * Deliberately SCOPED. A repo-wide version of this rule is unwritable: 76
 * workflows call the push-core-data action, and ~70 of them get their refusal
 * sentinel written from inside `scripts/validate-data.js` rather than from
 * YAML, which no workflow parser can see. A repo-wide assertion would produce
 * ~70 false offenders or an allowlist that means nothing. Same reasoning, and
 * the same SCOPED_JOBS shape, as tests/unit/workflow-audit-steps-always.test.mjs.
 */
const SCOPED_JOB = 'auto-apply';
const GATE_ID = 'commit-gate';

/** Steps that publish data outside the runner, and must never run unguarded. */
function isPublishingStep(step) {
  const uses = String(step.uses || '');
  const run = String(step.run || '');
  if (uses.includes('push-core-data')) return true;
  if (uses.includes('dispatch-deploy')) return true;
  if (run.includes('push-with-retry.sh')) return true;
  return false;
}

/** A step GitHub will run even after an earlier failure in the job. */
function isAlwaysReachable(step) {
  return String(step.if || '').includes('always()');
}

function loadJob() {
  const workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf-8'));
  const job = (workflow.jobs || {})[SCOPED_JOB];
  assert.ok(job, `${SCOPED_JOB} job not found in commercial-weekly.yml`);
  return job;
}

test('the workflow parses and the auto-apply job still publishes (guard against a vacuous pass)', () => {
  const job = loadJob();
  const steps = job.steps || [];
  assert.ok(steps.length > 5, `expected a substantial auto-apply job, found ${steps.length} steps`);

  const publishers = steps.filter(isPublishingStep);
  assert.ok(
    publishers.length >= 3,
    `expected at least 3 publishing steps (commit push, core-data push, deploy dispatch), found ${publishers.length}. ` +
      'If publishing genuinely moved out of this job, retire this test deliberately rather than letting it pass on an empty set.',
  );
});

test('the commit-gate barrier exists, runs if: always(), and actually refuses', () => {
  const steps = loadJob().steps || [];
  const gate = steps.find((s) => s.id === GATE_ID);

  assert.ok(gate, `no step with id: ${GATE_ID} — the fail-closed publish barrier is gone (BRO-2907)`);
  assert.ok(
    isAlwaysReachable(gate),
    `the ${GATE_ID} step must carry an if: containing always(), otherwise the earlier failure it exists to ` +
      `catch also skips the barrier itself. Found if: ${JSON.stringify(gate.if)}`,
  );

  // Assert against the BODY, not the env block. An earlier version of this
  // test matched /job\.status/ against run + JSON.stringify(env), which the
  // `JOB_STATUS: ${{ job.status }}` env line satisfied on its own — so the
  // whole body could be replaced with an echo and the test stayed green. A
  // reviewer proved exactly that on 2026-09-06.
  const body = String(gate.run || '');
  assert.match(
    body,
    /\$JOB_STATUS/,
    `the ${GATE_ID} body must branch on the job status, not merely receive it as an env var`,
  );
  // ...and the env must actually wire that variable to the real job status.
  // Pinning only the body lets someone set JOB_STATUS to a constant, which
  // keeps every body assertion green while the barrier can never fire.
  assert.match(
    String((gate.env || {}).JOB_STATUS ?? ''),
    /\$\{\{\s*job\.status\s*\}\}/,
    `the ${GATE_ID} step must set env JOB_STATUS from \${{ job.status }} — a literal value there ` +
      'disables the barrier while leaving its body untouched',
  );
  assert.match(
    body,
    /\.skip-push-core-data/,
    `the ${GATE_ID} body must write the push-core-data refusal sentinel on the refusal path`,
  );
  assert.match(
    body,
    /\bexit 1\b/,
    `the ${GATE_ID} body must exit non-zero on the refusal path, or its outcome stays 'success' ` +
      'and every publish step below is unblocked',
  );
  for (const f of [
    'data/commercial.json',
    'data/commercial-pending-review.json',
    'data/recoupment-calibration-anchors.json',
  ]) {
    assert.ok(
      body.includes(f),
      `the ${GATE_ID} body must restore ${f}; without it the mutation is left in the workspace`,
    );
  }
});

test('the commit-gate also catches the post-gate mutator that continue-on-error hides', () => {
  const steps = loadJob().steps || [];
  const gate = steps.find((s) => s.id === GATE_ID);
  assert.ok(gate, `no step with id: ${GATE_ID}`);

  // A `continue-on-error: true` step that FAILS leaves job.status 'success'.
  // That is fine for a read-only audit and NOT fine for one that writes, so
  // every continue-on-error step below the strict gate that mutates data must
  // be named in the barrier's own condition.
  const gateIndex = steps.indexOf(gate);
  const writers = steps
    .slice(0, gateIndex)
    .filter((s) => s['continue-on-error'] === true)
    .filter((s) => /merge-model-recoupment|apply-commercial-pending|dedupe-commercial/.test(String(s.run || '')));

  assert.ok(
    writers.length > 0,
    'expected at least one continue-on-error mutating step before the barrier; if that genuinely ' +
      'changed, retire this assertion deliberately rather than letting it pass on an empty set',
  );

  const gateText = String(gate.run || '') + JSON.stringify(gate.env || {});
  for (const w of writers) {
    assert.ok(w.id, `continue-on-error mutating step "${w.name}" has no id, so the barrier cannot check it`);
    assert.ok(
      gateText.includes(`steps.${w.id}.outcome`),
      `"${w.name}" is continue-on-error and mutates commercial data, so its failure leaves ` +
        `job.status 'success'. The ${GATE_ID} barrier must check steps.${w.id}.outcome explicitly.`,
    );
  }
});

test('every always()-reachable publishing step requires the gate to have SUCCEEDED', () => {
  const steps = loadJob().steps || [];
  const offenders = [];

  for (const step of steps) {
    if (!isPublishingStep(step)) continue;
    if (!isAlwaysReachable(step)) continue; // success()-gated already fails closed

    // Must be the exact `== 'success'` form. `!= 'failure'` is TRUE when the
    // barrier is skipped, and `|| true` / `|| <anything>` re-opens the hole
    // while still mentioning the outcome — both keep a substring check green.
    const cond = String(step.if || '');
    const ok =
      /steps\.commit-gate\.outcome\s*==\s*'success'/.test(cond) &&
      !/\|\|/.test(cond) &&
      !/!=/.test(cond);
    if (!ok) offenders.push(`${step.name || step.uses} (if: ${cond})`);
  }

  assert.deepEqual(
    offenders,
    [],
    `these always()-reachable steps publish commercial data without requiring steps.${GATE_ID}.outcome ` +
      `== 'success', so a skipped or weakened barrier would let a half-mutated workspace publish ` +
      `(BRO-2907):\n  ${offenders.join('\n  ')}`,
  );
});

test('the commit-gate barrier comes before every publishing step', () => {
  const steps = loadJob().steps || [];
  const gateIndex = steps.findIndex((s) => s.id === GATE_ID);
  assert.ok(gateIndex >= 0, `no step with id: ${GATE_ID}`);

  const tooEarly = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => isPublishingStep(step) && index < gateIndex)
    .map(({ step }) => step.name || step.uses);

  assert.deepEqual(
    tooEarly,
    [],
    `these publishing steps run BEFORE the ${GATE_ID} barrier, so the barrier cannot stop them:\n  ` +
      tooEarly.join('\n  '),
  );
});

/**
 * BRO-2912. `commit-gate` runs BEFORE the commit, so its outcome is already
 * fixed at 'success' when the commit runs. Under `always()` a FAILED commit
 * therefore does not stop "Push core data to private repo" or "Dispatch
 * deploy". That fired in run 33988453526 (schedule, 2026-09-05): the commit
 * step failed on push contention while both publishers succeeded. Because
 * push-core-data ships commercial.json (a CORE_FILE) but the consumed-entry
 * bookkeeping in commercial-pending-review.json only ever lands in the PUBLIC
 * repo, the two repos diverge and the next run re-applies applied entries.
 * commit-gate cannot catch it — it passed, so it never wrote the
 * .skip-push-core-data sentinel that push-core-data's own check reads.
 *
 * The commit step itself is EXCLUDED from the both-ids rule: isPublishingStep()
 * matches it (it runs push-with-retry.sh), and requiring a step to gate on its
 * own outcome is unsatisfiable.
 */
const COMMIT_ID = 'commit-public';

test('the public commit step carries an id, so later publishers can gate on it', () => {
  const steps = loadJob().steps || [];
  const commit = steps.find((s) => s.id === COMMIT_ID);

  assert.ok(
    commit,
    `no step with id: ${COMMIT_ID} — without an id nothing downstream can require the public ` +
      'commit to have succeeded (BRO-2912)',
  );
  assert.ok(
    isPublishingStep(commit),
    `the ${COMMIT_ID} step is expected to be the public commit+push. If publishing moved off it, ` +
      'retire this assertion deliberately rather than letting the id drift onto an unrelated step.',
  );
  // The commit is itself gated by the barrier, and must stay that way.
  assert.match(
    String(commit.if || ''),
    /steps\.commit-gate\.outcome\s*==\s*'success'/,
    `the ${COMMIT_ID} step must still require steps.${GATE_ID}.outcome == 'success'`,
  );
});

test('every publishing step AFTER the public commit requires that commit to have SUCCEEDED', () => {
  const steps = loadJob().steps || [];
  const commitIndex = steps.findIndex((s) => s.id === COMMIT_ID);
  assert.ok(commitIndex >= 0, `no step with id: ${COMMIT_ID}`);

  const downstream = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => isPublishingStep(step) && index > commitIndex)
    .filter(({ step }) => isAlwaysReachable(step)); // success()-gated already fails closed

  // Vacuity guard. If this set is ever empty the rule below passes while
  // asserting nothing — the exact read-as-safe-while-nothing-ran shape both
  // BRO-2907 and BRO-2912 were filed for.
  assert.ok(
    downstream.length >= 2,
    'expected at least 2 always()-reachable publishing steps after the public commit ' +
      '(core-data push, deploy dispatch), found ' +
      `${downstream.length}. If publishing genuinely moved, retire this test deliberately.`,
  );

  const offenders = [];
  for (const { step } of downstream) {
    const cond = String(step.if || '');
    // Same exact-form rule as the commit-gate assertion above: `!= 'failure'`
    // is TRUE when the step is skipped, and `||` re-opens the hole while
    // keeping a substring check green.
    const ok =
      /steps\.commit-public\.outcome\s*==\s*'success'/.test(cond) &&
      !/\|\|/.test(cond) &&
      !/!=/.test(cond);
    if (!ok) offenders.push(`${step.name || step.uses} (if: ${cond})`);
  }

  assert.deepEqual(
    offenders,
    [],
    `these steps publish commercial data AFTER the public commit without requiring ` +
      `steps.${COMMIT_ID}.outcome == 'success', so a failed commit still ships mutated ` +
      `commercial.json to the private repo and dispatches a deploy (BRO-2912):\n  ${offenders.join('\n  ')}`,
  );
});

test('the public commit comes before the core-data push and the deploy dispatch', () => {
  const steps = loadJob().steps || [];
  const commitIndex = steps.findIndex((s) => s.id === COMMIT_ID);
  assert.ok(commitIndex >= 0, `no step with id: ${COMMIT_ID}`);

  // A position rule, not a name matcher: reordering the id above these steps
  // would satisfy the id check while restoring the bug.
  const tooEarly = steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step, index }) =>
        index < commitIndex &&
        (String(step.uses || '').includes('push-core-data') ||
          String(step.uses || '').includes('dispatch-deploy')),
    )
    .map(({ step }) => step.name || step.uses);

  assert.deepEqual(
    tooEarly,
    [],
    `these steps publish BEFORE the ${COMMIT_ID} step, so gating them on its outcome is ` +
      `meaningless:\n  ${tooEarly.join('\n  ')}`,
  );
});

test('the public commit step cannot swallow its own push failure', () => {
  const steps = loadJob().steps || [];
  const commit = steps.find((s) => s.id === COMMIT_ID);
  assert.ok(commit, `no step with id: ${COMMIT_ID}`);

  // A reviewer defeated the guards above by appending `|| true` to the
  // push-with-retry.sh line: the step then exits 0, its outcome stays
  // 'success', and both downstream publishers run — BRO-2912 restored, with
  // every YAML-wiring assertion still green. The wiring assertions cannot see
  // it because they read `if:`/`id`/`uses` and never the body. commit-gate
  // already has body assertions for the same reason; this is the matching
  // pair for the commit.
  const body = String(commit.run || '');
  const pushLines = body.split('\n').filter((l) => l.includes('push-with-retry.sh'));

  assert.ok(
    pushLines.length > 0,
    `the ${COMMIT_ID} body must actually invoke push-with-retry.sh; if the push moved, retire ` +
      'this assertion deliberately rather than letting it pass on an empty set',
  );
  for (const line of pushLines) {
    assert.doesNotMatch(
      line,
      /\|\|\s*(true|:)\s*$/,
      `the ${COMMIT_ID} push must not be suffixed with "|| true" or "|| :" — that makes a failed ` +
        `push exit 0, so steps.${COMMIT_ID}.outcome stays 'success' and the publish steps below ` +
        `run anyway. That is exactly the BRO-2912 bug, invisible to every if:-based assertion.\n  ${line.trim()}`,
    );
  }
  assert.doesNotMatch(
    body,
    /^\s*set \+e\s*$/m,
    `the ${COMMIT_ID} body must not disable errexit with "set +e" — a failed push would stop ` +
      'setting the step outcome to failure',
  );

  // One edit from confusing: continue-on-error would not actually bypass the
  // guard (GHA reports `outcome` pre-continue-on-error) but it makes the
  // conclusion diverge from the outcome for no reason here.
  assert.notEqual(
    commit['continue-on-error'],
    true,
    `the ${COMMIT_ID} step must not be continue-on-error: its failure is the signal the publish ` +
      'steps below depend on',
  );
});
