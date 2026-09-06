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
 * `lint-workflows` was added 2026-09-06 (BRO-2906). Its count was NOT 7 as the
 * card said: 31 of its 61 steps invoke a scripts/audit-*.js and none carried an
 * `if:`. It uses the compound `always() && steps.deps.outcome == 'success'`
 * rather than data-validation's bare `always()`, because a blanket always()
 * there would run 31 audits after a failed checkout and emit 31 confusing
 * missing-file errors.
 *
 * That partial coverage is now CLOSED. The 25 sibling "Audit — …"/"Check …"
 * steps that run inline `node -e`, `scripts/lint-*.js`, `scripts/assert-*.js`
 * or plain shell were still masking each other, because auditSteps() matches
 * on `scripts/audit-*.js` and is blind to them. Rather than widen the matcher —
 * which only moves the blind spot to whatever shape someone writes next — the
 * lint-workflows job also carries a POSITION rule below: every step after the
 * `deps` anchor must be fail-closed, with no name matching at all. That is the
 * rule that would have caught these 25.
 *
 * KNOWN EDGE, deliberately accepted: every rule here is scoped to named jobs,
 * so a NEW job with unguarded audits is invisible to this file. A repo-wide
 * rule is unwritable for the reason tests/unit/commercial-publish-gate.test.mjs
 * documents — most equivalent enforcement lives inside scripts, not in YAML a
 * parser can see. Recorded so the next reader knows it is a known edge.
 */
const SCOPED_JOBS = new Set(['data-validation', 'lint-workflows']);

/**
 * An audit step is only genuinely unmaskable if its condition is one of these
 * two exact shapes. Checking merely that the string CONTAINS `always()` is not
 * enough — `always() && false`, `always() && steps.x.outcome != 'failure'`
 * (true when x is skipped) and `always() && (… || true)` all contain it while
 * reopening the hole. BRO-2906.
 */
const ACCEPTED_CONDITIONS = [
  /^always\(\)$/,
  /^always\(\)\s*&&\s*steps\.[A-Za-z0-9_-]+\.outcome\s*==\s*'success'$/,
];

function conditionIsFailClosed(cond) {
  const c = String(cond || '').trim();
  if (/\|\|/.test(c)) return false; // an OR can always be made true
  if (/!=/.test(c)) return false; // != 'failure' is true when the step is SKIPPED
  return ACCEPTED_CONDITIONS.some((re) => re.test(c));
}

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
  // Raised from 20 to 50 when lint-workflows joined SCOPED_JOBS (BRO-2906).
  // data-validation alone contributes 24, so a floor of 20 would still pass
  // even if every lint-workflows step silently vanished — the guard against a
  // vacuous pass would itself have become vacuous.
  assert.ok(
    steps.length >= 50,
    `expected at least 50 audit-*.js steps across ${[...SCOPED_JOBS].join(' + ')}, found ${steps.length} — the matcher or the workflow shape changed`
  );
});

test('every audit-*.js CI step carries if: always(), so an earlier failure cannot hide it', () => {
  const workflow = loadWorkflow();
  const offenders = auditSteps(workflow).filter((step) => {
    if (EXEMPT.has(step.name)) return false;
    return !conditionIsFailClosed(step.if);
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

test('a step gated on steps.<id>.outcome actually runs AFTER that step (BRO-2906)', () => {
  const workflow = loadWorkflow();
  const problems = [];

  for (const [jobId, job] of Object.entries(workflow.jobs || {})) {
    if (!SCOPED_JOBS.has(jobId)) continue;
    const steps = job.steps || [];
    const indexOfId = new Map();
    steps.forEach((s, i) => { if (s.id) indexOfId.set(s.id, i); });

    steps.forEach((step, i) => {
      const m = String(step.if || '').match(/steps\.([A-Za-z0-9_-]+)\.outcome/);
      if (!m) return;
      const refId = m[1];
      if (!indexOfId.has(refId)) {
        problems.push(`${jobId} / ${step.name}: gated on steps.${refId} which has no step carrying that id`);
        return;
      }
      if (indexOfId.get(refId) > i) {
        problems.push(`${jobId} / ${step.name}: gated on steps.${refId}, which runs LATER (index ${indexOfId.get(refId)} vs ${i})`);
      }
    });
  }

  assert.deepEqual(
    problems,
    [],
    'A gate referencing a step that runs later, or no step at all, evaluates to a non-success ' +
      'outcome forever, so the gated step never runs and the guard silently protects nothing:\n  ' +
      problems.join('\n  ')
  );
});

/**
 * The ordering test above is not enough on its own. A reviewer defeated it by
 * inserting a decoy `id: gate` step carrying `if: false` ABOVE Setup Node and
 * repointing all 32 gates at it: every audit is then permanently skipped and
 * all tests still passed. Two more invariants close that, and the related case
 * where a new failing step is slipped in ahead of the step the gates depend on.
 */
test('lint-workflows gates reference the real, unconditional deps step (BRO-2906)', () => {
  const steps = loadWorkflow().jobs['lint-workflows'].steps || [];

  const wrongRef = steps
    .filter((s) => /steps\.[A-Za-z0-9_-]+\.outcome/.test(String(s.if || '')))
    .filter((s) => !/steps\.deps\.outcome/.test(String(s.if || '')))
    .map((s) => `${s.name}: ${s.if}`);
  assert.deepEqual(
    wrongRef,
    [],
    'these steps gate on something other than steps.deps — a decoy step that is always skipped ' +
      'would permanently disable every audit while looking correctly gated:\n  ' + wrongRef.join('\n  ')
  );

  const deps = steps.find((s) => s.id === 'deps');
  assert.ok(deps, 'no step carries id: deps');
  assert.equal(
    deps.if,
    undefined,
    `the deps step must be unconditional; with an if: (${JSON.stringify(deps.if)}) it can evaluate ` +
      'to skipped forever, and every audit gated on its outcome is then skipped forever too'
  );
});

test('nothing new sits ahead of the deps step that could skip it (BRO-2906)', () => {
  const steps = loadWorkflow().jobs['lint-workflows'].steps || [];
  const depsIndex = steps.findIndex((s) => s.id === 'deps');
  assert.ok(depsIndex >= 0, 'no step carries id: deps');

  // Anything before deps that FAILS leaves deps skipped, which re-masks all 31
  // audits while every other assertion here stays green. Keep that prefix an
  // explicit allowlist so adding to it is a deliberate, reviewed act.
  const ALLOWED_PREFIX = ['Checkout', 'Install actionlint', 'Setup Node (for orphan-test audit)'];
  const actual = steps.slice(0, depsIndex).map((s) => String(s.name || s.uses));
  assert.deepEqual(
    actual,
    ALLOWED_PREFIX,
    'the steps preceding `deps` changed. Every one of them can skip `deps` by failing, which ' +
      'silently re-masks all 31 gated audits. If the new step is genuinely required setup, add it ' +
      'to ALLOWED_PREFIX deliberately; if it is an audit, it belongs BELOW the gate.'
  );
});

test('lint-workflows runs its setup BEFORE the job-fatal actionlint step (BRO-2906)', () => {
  const steps = loadWorkflow().jobs['lint-workflows'].steps || [];
  const idx = (pred) => steps.findIndex(pred);

  const deps = idx((s) => s.id === 'deps');
  const lint = idx((s) => String(s.name || '') === 'Lint workflow files');

  assert.ok(deps >= 0, 'no step carries id: deps — the audit gates below reference it');
  assert.ok(lint >= 0, 'the "Lint workflow files" step is gone');
  assert.ok(
    lint > deps,
    '"Lint workflow files" (actionlint) runs BEFORE the deps step it is ordered after. actionlint ' +
      'is job-fatal — it has no continue-on-error, whatever .github/workflows/CLAUDE.md may say — ' +
      'so with it above the setup, an actionlint failure leaves steps.deps skipped and EVERY audit ' +
      `gated on it is skipped too. The unmasking fix silently does nothing. (deps=${deps}, lint=${lint})`
  );
});

/**
 * The POSITION rule. Everything after the `deps` anchor in lint-workflows is an
 * independent read-only check, so it must be fail-closed — no name matching,
 * because name matching is what let 25 steps sit unguarded while every other
 * assertion in this file was green. A new gate written as
 * `bash scripts/lint-workflow-guards.sh <name>` or an inline `node -e` is
 * covered here by position alone.
 */
const POSITION_FLOOR = 55;

function postAnchorSteps() {
  const steps = loadWorkflow().jobs['lint-workflows'].steps || [];
  const anchors = [];
  steps.forEach((s, i) => { if (s.id === 'deps') anchors.push(i); });
  return { steps, anchors, after: anchors.length === 1 ? steps.slice(anchors[0] + 1) : [] };
}

test('EVERY lint-workflows step after the deps anchor is fail-closed, by position not by name', () => {
  const { anchors, after } = postAnchorSteps();

  assert.equal(
    anchors.length,
    1,
    `lint-workflows has ${anchors.length} steps with \`id: deps\` — expected exactly 1. With zero this ` +
      'rule silently checks nothing; with two the split is ambiguous and findIndex would quietly take the first.'
  );
  // Per-job floor. The shared floor above counts data-validation too, so it
  // stays satisfied even if every lint-workflows step vanished.
  assert.ok(
    after.length >= POSITION_FLOOR,
    `only ${after.length} lint-workflows steps after the deps anchor, expected >= ${POSITION_FLOOR} — the job shrank or the anchor moved, and this rule is now checking almost nothing`
  );

  const offenders = after
    .filter((s) => !EXEMPT.has(`lint-workflows / ${s.name || '(unnamed)'}`))
    .filter((s) => !conditionIsFailClosed(s.if))
    .map((s) => `lint-workflows / ${s.name || '(unnamed)'}\n      if: ${JSON.stringify(s.if)}`);

  assert.deepEqual(
    offenders,
    [],
    'These steps run after the dependency install and are independent read-only checks, but are not ' +
      'fail-closed, so any earlier failure in the job SKIPS them and the run reports nothing about what ' +
      'they check. This rule is by POSITION, so it covers inline `node -e`, scripts/lint-*.js, ' +
      'scripts/assert-*.js and plain shell — the shapes the name matcher misses:\n' +
      offenders.map((o) => `  - ${o}`).join('\n')
  );
});

test('no lint-workflows audit uses continue-on-error, which masks a failure a different way', () => {
  const { after } = postAnchorSteps();

  // Offend on the key being PRESENT, not on it being `true`. GitHub accepts an
  // expression here, and `continue-on-error: ${{ true }}` parses as a STRING,
  // so a `!== true` check waves it through while GitHub evaluates it truthy.
  const offenders = after
    .filter((s) => Object.prototype.hasOwnProperty.call(s, 'continue-on-error'))
    .filter((s) => s['continue-on-error'] !== false)
    .map((s) => `lint-workflows / ${s.name || '(unnamed)'} (continue-on-error: ${JSON.stringify(s['continue-on-error'])})`);

  assert.deepEqual(
    offenders,
    [],
    'These steps carry `continue-on-error`. The step then RUNS, FAILS, and the job stays green — ' +
      'identical masking to the skipped-step bug by a different mechanism, with every other assertion ' +
      'in this file still passing:\n' + offenders.map((o) => `  - ${o}`).join('\n')
  );
});

test('the two steps fixed on 2026-09-06 specifically carry if: always()', () => {
  const workflow = loadWorkflow();
  // Keyed on `${jobId} / ${name}`: with two jobs in SCOPED_JOBS a bare step
  // name collides silently and the last one parsed wins.
  const byName = new Map(auditSteps(workflow).map((s) => [`${s.jobId} / ${s.name}`, s]));
  for (const name of [
    'data-validation / Audit critic-outlet affinities',
    'data-validation / Audit Broadway-category predicate re-derivations',
    'data-validation / Audit outlet-registry gaps',
  ]) {
    const step = byName.get(name);
    assert.ok(step, `step "${name}" not found — was it renamed? Update this test deliberately.`);
    assert.ok(
      typeof step.if === 'string' && step.if.includes('always()'),
      `step "${name}" lost its if: always() — an earlier failure would silently skip it again`
    );
  }
});
