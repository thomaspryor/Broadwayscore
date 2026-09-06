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
