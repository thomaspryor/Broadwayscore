import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'update-show-status.yml');

const {
  failureSwallowOffenders,
  isAlwaysReachable,
  isPublishingStep,
  jobPublishes,
  pushInvocationLines,
  requiresOutcomeSuccess,
  requiresUpstreamSuccess,
} = require(path.join(REPO_ROOT, 'scripts', 'lib', 'workflow-publish-gate.js'));

/**
 * BRO-2913 — the sibling of BRO-2912, in a different workflow.
 *
 * `update-show-status.yml`'s `update-shows` job has the same
 * publish-after-failed-commit hole: `commit-gate` runs BEFORE the commit, so
 * its outcome is fixed at 'success' by the time the commit runs, and the
 * publishers below are `if: always()`. Observed live in run 32947722300
 * (schedule, 2026-08-26): step 31 commit-gate `success`, step 36 "Commit and
 * push changes" FAILURE, step 43 "Push core data to private repo" `success`.
 *
 * It also used the WEAKER `!= 'failure'` comparison, which is TRUE when the
 * barrier is skipped or cancelled — the read-as-safe-while-nothing-ran shape
 * BRO-2907's own barrier comment warns against.
 *
 * Deliberately SCOPED to one job, for the same reason as
 * tests/unit/commercial-publish-gate.test.mjs: 76 workflows call the
 * push-core-data action and ~70 of them get their refusal sentinel written
 * from inside scripts/validate-data.js rather than from YAML, which no
 * workflow parser can see. A repo-wide assertion would produce ~70 false
 * offenders, or an allowlist that means nothing.
 */
const SCOPED_JOB = 'update-shows';
const GATE_ID = 'commit-gate';
const COMMIT_ID = 'commit-public';

/**
 * Publishing steps that are deliberately NOT gated on the public commit,
 * recorded here by name so the exclusion is a decision rather than an
 * invisible gap. Each is asserted to still exist, so this map cannot quietly
 * become a way to smuggle a new ungated publisher past the rules below.
 */
const UNGATED_BY_DESIGN = new Map([
  [
    'Push aggregator-archive to private repo',
    'append-only scrape cache with no pairing to shows.json — losing a run of scrapes to an ' +
      'unrelated failed public commit would be a pure regression',
  ],
  [
    'Push discovery-blocked audit to private repo',
    'exists to record the failure path; gating it on success would delete the evidence',
  ],
]);

function loadJob(name = SCOPED_JOB) {
  const workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf-8'));
  const job = (workflow.jobs || {})[name];
  assert.ok(job, `${name} job not found in update-show-status.yml`);
  return job;
}

function loadWorkflow() {
  return yaml.load(fs.readFileSync(WORKFLOW, 'utf-8'));
}

const stepLabel = (step) => step.name || step.uses || '(unnamed step)';

test('the workflow parses and the update-shows job still publishes (guard against a vacuous pass)', () => {
  const steps = loadJob().steps || [];
  assert.ok(steps.length > 20, `expected a substantial update-shows job, found ${steps.length} steps`);

  const publishers = steps.filter(isPublishingStep);
  assert.ok(
    publishers.length >= 4,
    `expected at least 4 publishing steps (public commit, aggregator-archive push, core-data push, ` +
      `deploy dispatch), found ${publishers.length}. If publishing genuinely moved out of this job, ` +
      'retire this test deliberately rather than letting it pass on an empty set.',
  );
});

test('the deliberately-ungated publishers still exist, so the exclusion list cannot go stale', () => {
  const steps = loadJob().steps || [];
  const names = new Set(steps.map(stepLabel));
  for (const [name, why] of UNGATED_BY_DESIGN) {
    assert.ok(
      names.has(name),
      `"${name}" is on the deliberately-ungated list (${why}) but no longer exists in the ` +
        `${SCOPED_JOB} job. Remove it from UNGATED_BY_DESIGN rather than leaving a stale exemption ` +
        'that a future step could inherit by reusing the name.',
    );
  }
});

test('the commit-gate barrier exists, runs if: always(), and actually refuses', () => {
  const steps = loadJob().steps || [];
  const gate = steps.find((s) => s.id === GATE_ID);

  assert.ok(gate, `no step with id: ${GATE_ID} — the fail-closed publish barrier is gone`);
  assert.ok(
    isAlwaysReachable(gate),
    `the ${GATE_ID} step must carry an if: containing always(), otherwise the earlier failure it ` +
      `exists to catch also skips the barrier itself. Found if: ${JSON.stringify(gate.if)}`,
  );

  // Body, not wiring: an earlier reviewer proved on the sibling workflow that
  // a barrier's whole body can be replaced with an echo while every
  // if:-based assertion stays green.
  const body = String(gate.run || '');
  assert.match(
    body,
    /\bexit 1\b/,
    `the ${GATE_ID} body must exit non-zero on the refusal path, or its outcome stays 'success' ` +
      'and every publish step below is unblocked',
  );
  assert.match(
    body,
    /steps\.validate\.outcome/,
    `the ${GATE_ID} body must fail closed when validation was SKIPPED — a missing post-validate ` +
      'file otherwise reads as "0 post errors" and the gate wrongly passes',
  );
  assert.match(
    body,
    /should_commit/,
    `the ${GATE_ID} body must branch on the validation set-diff, not merely run`,
  );
});

test('every always()-reachable publishing step requires the gate to have SUCCEEDED', () => {
  const steps = loadJob().steps || [];
  const offenders = [];

  for (const step of steps) {
    if (!isPublishingStep(step)) continue;
    if (!isAlwaysReachable(step)) continue; // success()-gated already fails closed
    if (UNGATED_BY_DESIGN.has(stepLabel(step))) continue;

    if (!requiresOutcomeSuccess(step.if, GATE_ID)) {
      offenders.push(`${stepLabel(step)} (if: ${String(step.if || '')})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these always()-reachable steps publish show data without requiring steps.${GATE_ID}.outcome ` +
      `== 'success', so a skipped, cancelled or weakened barrier would let an unvalidated workspace ` +
      `publish:\n  ${offenders.join('\n  ')}`,
  );
});

test('the public commit step carries an id, publishes, and is itself gated', () => {
  const steps = loadJob().steps || [];
  const commit = steps.find((s) => s.id === COMMIT_ID);

  assert.ok(
    commit,
    `no step with id: ${COMMIT_ID} — without an id nothing downstream can require the public ` +
      'commit to have succeeded (BRO-2913)',
  );
  assert.ok(
    isPublishingStep(commit),
    `the ${COMMIT_ID} step is expected to be the public commit+push. If publishing moved off it, ` +
      'retire this assertion deliberately rather than letting the id drift onto an unrelated step.',
  );
  // Comment-stripped, so a bare `# see push-with-retry.sh` in a decoy step's
  // body cannot satisfy the publishing predicate.
  assert.ok(
    pushInvocationLines(commit).length > 0,
    `the ${COMMIT_ID} body must actually invoke push-with-retry.sh outside a comment; if the push ` +
      'moved, retire this assertion deliberately rather than letting it pass on an empty set',
  );
  assert.match(
    String(commit.run || ''),
    /\bgit commit\b/,
    `the ${COMMIT_ID} body must actually commit — otherwise the id can drift onto a step that ` +
      'merely pushes something else, and the gate below means nothing',
  );
  assert.ok(
    requiresOutcomeSuccess(commit.if, GATE_ID),
    `the ${COMMIT_ID} step must require steps.${GATE_ID}.outcome == 'success' (exact form — ` +
      `"!= 'failure'" is TRUE for a skipped or cancelled barrier). Found if: ${JSON.stringify(commit.if)}`,
  );
});

test('exactly one step carries the commit id, and no decoy step mimics it', () => {
  const steps = loadJob().steps || [];
  const withId = steps.filter((s) => s.id === COMMIT_ID);
  assert.equal(
    withId.length,
    1,
    `expected exactly one step with id: ${COMMIT_ID}, found ${withId.length}. A second one lets a ` +
      'decoy absorb the gate while the real commit publishes ungated.',
  );

  // The real commit is the only step in this job that both commits AND pushes.
  const committers = steps.filter(
    (s) => /\bgit commit\b/.test(String(s.run || '')) && pushInvocationLines(s).length > 0,
  );
  assert.ok(
    committers.some((s) => s.id === COMMIT_ID),
    `the step with id: ${COMMIT_ID} must be one of the commit+push steps in this job, not a ` +
      `decoy. Commit+push steps found: ${committers.map(stepLabel).join(', ') || '(none)'}`,
  );
});

test('every publishing step AFTER the public commit requires that commit to have SUCCEEDED', () => {
  const steps = loadJob().steps || [];
  const commitIndex = steps.findIndex((s) => s.id === COMMIT_ID);
  assert.ok(commitIndex >= 0, `no step with id: ${COMMIT_ID}`);

  const downstream = steps
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => isPublishingStep(step) && index > commitIndex)
    .filter(({ step }) => isAlwaysReachable(step)) // success()-gated already fails closed
    .filter(({ step }) => !UNGATED_BY_DESIGN.has(stepLabel(step)));

  // Vacuity guard. An empty set makes the rule below pass while asserting
  // nothing — the exact read-as-safe-while-nothing-ran shape this card was
  // filed for. Two are expected: the core-data push and the deploy dispatch.
  assert.ok(
    downstream.length >= 2,
    'expected at least 2 gated always()-reachable publishing steps after the public commit ' +
      `(core-data push, deploy dispatch), found ${downstream.length}. If publishing genuinely ` +
      'moved, retire this test deliberately.',
  );

  const offenders = downstream
    .filter(({ step }) => !requiresOutcomeSuccess(step.if, COMMIT_ID))
    .map(({ step }) => `${stepLabel(step)} (if: ${String(step.if || '')})`);

  assert.deepEqual(
    offenders,
    [],
    `these steps publish AFTER the public commit without requiring steps.${COMMIT_ID}.outcome == ` +
      `'success', so a failed commit still ships shows.json to the private core-data repo while ` +
      `new-shows-pending.json is permanently lost (BRO-2913):\n  ${offenders.join('\n  ')}`,
  );
});

test('the public commit comes before the core-data push and the deploy dispatch', () => {
  const steps = loadJob().steps || [];
  const commitIndex = steps.findIndex((s) => s.id === COMMIT_ID);
  assert.ok(commitIndex >= 0, `no step with id: ${COMMIT_ID}`);

  // A position rule, not a name matcher: moving the id below these steps
  // would satisfy the id check while restoring the bug.
  const tooEarly = steps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step, index }) =>
        index < commitIndex &&
        (String(step.uses || '').includes('push-core-data') ||
          /\bgh workflow run\b/.test(String(step.run || ''))),
    )
    .map(({ step }) => stepLabel(step));

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

  assert.ok(
    pushInvocationLines(commit).length > 0,
    `the ${COMMIT_ID} body must actually invoke push-with-retry.sh; if the push moved, retire ` +
      'this assertion deliberately rather than letting it pass on an empty set',
  );

  const offenders = failureSwallowOffenders(commit);
  assert.deepEqual(
    offenders,
    [],
    `the ${COMMIT_ID} step can swallow its own push failure, which leaves its outcome 'success' ` +
      `and unblocks every publisher below — BRO-2913 fully restored with every if:-based ` +
      `assertion still green:\n  ${offenders.join('\n  ')}`,
  );
});

/**
 * Jobs that publish on the FAILURE path by design. Named, so the exemption is
 * a recorded decision; asserted to still exist, so it cannot go stale and be
 * inherited by an unrelated future job that reuses the name.
 */
const JOBS_UNGATED_BY_DESIGN = new Map([
  [
    'alert-on-failure',
    "runs on if: failure() and commits the alert ledger — gating it on upstream success would " +
      'delete the record of the very failure it exists to report',
  ],
]);

test('the failure-path jobs on the exemption list still exist', () => {
  const workflow = loadWorkflow();
  for (const [jobName, why] of JOBS_UNGATED_BY_DESIGN) {
    assert.ok(
      (workflow.jobs || {})[jobName],
      `job "${jobName}" is exempted from the cross-job publish rule (${why}) but no longer ` +
        'exists. Remove it from JOBS_UNGATED_BY_DESIGN rather than leaving a stale exemption.',
    );
  }
});

test('no OTHER job in this workflow publishes without requiring update-shows to have succeeded', () => {
  const workflow = loadWorkflow();
  const offenders = [];

  for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
    if (jobName === SCOPED_JOB) continue;
    if (JOBS_UNGATED_BY_DESIGN.has(jobName)) continue;

    // jobPublishes() also catches a job-level `uses:` (reusable workflow),
    // which has NO steps for a step-walking predicate to see — a reviewer
    // published unconditionally from exactly that shape.
    if (!jobPublishes(job)) continue;

    // requiresUpstreamSuccess() models GitHub reachability, not YAML text:
    // "lacks always()" is NOT the same as "fails closed", because
    // `!cancelled()` overrides implicit needs-gating too.
    // Passing the whole jobs map resolves `needs` TRANSITIVELY: a job that
    // needs a job that needs update-shows does fail closed on GitHub, and
    // flagging it would be a false positive that blocks a legitimate refactor
    // of the fan-out jobs.
    if (!requiresUpstreamSuccess(job, SCOPED_JOB, workflow.jobs || {})) {
      const what = job.uses
        ? `reusable workflow ${job.uses}`
        : (job.steps || []).filter(isPublishingStep).map(stepLabel).join(', ');
      offenders.push(
        `job "${jobName}" publishes (${what}) with ` +
          `needs: ${JSON.stringify(job.needs || null)} and if: ${JSON.stringify(job.if || null)}`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'a publisher moved into a sibling job escapes the job-scoped rules above entirely, because ' +
      `steps.${COMMIT_ID} resolves to an empty string outside ${SCOPED_JOB}. Every other job that ` +
      `publishes must require needs.${SCOPED_JOB}.result == 'success':\n  ${offenders.join('\n  ')}`,
  );
});
