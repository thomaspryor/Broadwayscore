import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'test.yml');

/**
 * A CI step with no `if:` key defaults to `if: success()`, so ANY earlier
 * failure in its job silently SKIPS it. For a read-only audit that is the
 * worst possible failure mode: the gate that would have diagnosed the problem
 * is the thing the problem removes, and the run reports nothing at all.
 *
 * That is not hypothetical. On 2026-09-06 "Audit outlet-registry gaps" had no
 * `if:`; an outlet registered with `starScale: null` failed the earlier
 * "Run data validation" step, which skipped the registry audit; and two
 * consecutive runs reported NOTHING about the registry — including the run
 * whose whole purpose was to verify the registry fix. Absence of a signal read
 * as safety.
 *
 * Two more steps were found carrying the same shape on 2026-09-06
 * ("Audit critic-outlet affinities" and "Audit Broadway-category predicate
 * re-derivations"). This test exists so the next one is caught by CI instead
 * of by a crown session reading YAML.
 *
 * Rule: every step that runs a `scripts/audit-*.js` script must carry an `if:`
 * containing `always()`. Anything that genuinely must not run after an earlier
 * failure has to be named in EXEMPT below, deliberately and with a reason.
 */
const EXEMPT = new Map([
  // stepName -> why it must NOT run after an earlier failure
]);

/**
 * Scoped to the job where the 2026-09-06 incident happened and where the
 * change was reviewed.
 *
 * The `lint-workflows` job has the same shape in 7 more steps, but widening
 * this rule there is a separate call needing its own review under the
 * shared-infrastructure rule: that job's earlier steps are checkout/setup, so
 * whether an audit should still run after they fail is a different question
 * from a 56-step data job. Tracked on Linear rather than folded in silently.
 */
const SCOPED_JOBS = new Set(['data-validation']);

function loadWorkflow() {
  return yaml.load(fs.readFileSync(WORKFLOW, 'utf-8'));
}

/** Every step across every job that invokes a scripts/audit-*.js script. */
function auditSteps(workflow) {
  const found = [];
  for (const [jobId, job] of Object.entries(workflow.jobs || {})) {
    if (!SCOPED_JOBS.has(jobId)) continue;
    for (const step of job.steps || []) {
      const run = typeof step.run === 'string' ? step.run : '';
      if (!/\bnode\s+scripts\/audit-[\w-]+\.js\b/.test(run)) continue;
      found.push({
        jobId,
        name: step.name || '(unnamed)',
        run: run.trim().split('\n')[0],
        if: step.if,
      });
    }
  }
  return found;
}

test('the workflow parses and actually contains audit steps (guard against a vacuous pass)', () => {
  const workflow = loadWorkflow();
  const steps = auditSteps(workflow);
  // If this ever drops to 0 the assertions below would pass while checking
  // nothing — the exact silence-reads-as-safety shape this file is about.
  assert.ok(
    steps.length >= 20,
    `expected at least 20 audit-*.js steps, found ${steps.length} — the matcher or the workflow shape changed`
  );
});

test('every audit-*.js CI step carries if: always(), so an earlier failure cannot hide it', () => {
  const workflow = loadWorkflow();
  const offenders = auditSteps(workflow).filter((step) => {
    if (EXEMPT.has(step.name)) return false;
    const cond = typeof step.if === 'string' ? step.if : '';
    return !cond.includes('always()');
  });

  assert.deepEqual(
    offenders.map((o) => `${o.jobId} / ${o.name}`),
    [],
    'These audit steps have no `if: always()`, so any earlier failure in their job SKIPS them and ' +
      'the run reports nothing about what they check — the 2026-09-06 outlet-registry incident. ' +
      'Add `if: always()` (they are read-only), or add the step to EXEMPT with a reason:\n' +
      offenders.map((o) => `  - ${o.jobId} / ${o.name}\n      if: ${JSON.stringify(o.if)}\n      run: ${o.run}`).join('\n')
  );
});

test('the two steps fixed on 2026-09-06 specifically carry if: always()', () => {
  const workflow = loadWorkflow();
  const byName = new Map(auditSteps(workflow).map((s) => [s.name, s]));
  for (const name of [
    'Audit critic-outlet affinities',
    'Audit Broadway-category predicate re-derivations',
    'Audit outlet-registry gaps',
  ]) {
    const step = byName.get(name);
    assert.ok(step, `step "${name}" not found — was it renamed? Update this test deliberately.`);
    assert.ok(
      typeof step.if === 'string' && step.if.includes('always()'),
      `step "${name}" lost its if: always() — an earlier failure would silently skip it again`
    );
  }
});
