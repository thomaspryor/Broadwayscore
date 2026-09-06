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

test('the commit-gate barrier exists, runs if: always(), and fails closed on job.status', () => {
  const steps = loadJob().steps || [];
  const gate = steps.find((s) => s.id === GATE_ID);

  assert.ok(gate, `no step with id: ${GATE_ID} — the fail-closed publish barrier is gone (BRO-2907)`);
  assert.ok(
    isAlwaysReachable(gate),
    `the ${GATE_ID} step must carry an if: containing always(), otherwise the earlier failure it exists to ` +
      `catch also skips the barrier itself. Found if: ${JSON.stringify(gate.if)}`,
  );
  assert.match(
    String(gate.run || '') + JSON.stringify(gate.env || {}),
    /job\.status/,
    `the ${GATE_ID} step must key off job.status so it fails closed on ANY earlier failure, including ` +
      'steps added later that nobody remembered to add to a guard.',
  );
});

test('every always()-reachable publishing step is gated on the commit-gate outcome', () => {
  const steps = loadJob().steps || [];
  const offenders = [];

  for (const step of steps) {
    if (!isPublishingStep(step)) continue;
    if (!isAlwaysReachable(step)) continue; // success()-gated already fails closed
    if (!String(step.if || '').includes(`steps.${GATE_ID}.outcome`)) {
      offenders.push(`${step.name || step.uses} (if: ${step.if})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these always()-reachable steps publish commercial data without keying off ' +
      `steps.${GATE_ID}.outcome, so an earlier failure would publish a half-mutated workspace ` +
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
