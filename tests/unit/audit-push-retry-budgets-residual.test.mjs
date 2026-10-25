import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const audit = require('../../scripts/lib/audit-push-retry-budgets.js');

const workflow = (steps, minutes = 30) => `jobs:
  build:
    timeout-minutes: ${minutes}
    steps:
${steps}`;
const pushStep = (name, extra = '') => `      - name: ${name}
${extra}        run: bash scripts/lib/push-with-retry.sh
`;

test('BRO-5312: the default residual includes every documented post-deadline phase', () => {
  // 100s in flight, 180s rebase CPU, 30s post-resolution push, 200s
  // survival fetches, 190s API attempt, 100s post-API refresh.
  assert.equal(audit.computeResidualPastDeadlineSec(), 800);
  assert.equal(audit.computeResidualPastDeadlineSec({ gitNetTimeoutSec: 30 }), 530);
  assert.equal(audit.computeResidualPastDeadlineSec({ gitNetTimeoutSec: 120 }), 950);
});

test('BRO-5312: timeout defaults come from the push implementation', () => {
  const source = readFileSync(new URL('../../scripts/lib/push-with-retry.sh', import.meta.url), 'utf8');
  assert.equal(audit.GIT_NET_TIMEOUT_SEC, Number(source.match(/^GIT_NET_TIMEOUT_SEC=\$\{GIT_NET_TIMEOUT_SEC:-(\d+)\}/m)[1]));
  assert.equal(audit.PUSH_OP_MIN_TIMEOUT_SEC, Number(source.match(/^PUSH_OP_MIN_TIMEOUT_SEC=\$\{PUSH_OP_MIN_TIMEOUT_SEC:-(\d+)\}/m)[1]));
});

test('BRO-5312: a deadline-sized job warns without changing the existing hard gate', () => {
  const result = audit.evaluateStep({ maxRetries: 7, deadlineSec: 240, jobTimeoutMinutes: 5 });
  assert.equal(result.stepBudgetSec, 240);
  assert.equal(result.residualPastDeadlineSec, 800);
  assert.equal(result.stepBudgetWithResidualSec, 1040);
  assert.equal(result.marginSec, 60);
  assert.equal(result.marginWithResidualSec, -740);
  assert.ok(!result.flags.includes('job-timeout-margin-undersized'));
  assert.deepEqual(result.advisoryFlags, ['job-timeout-margin-with-residual-undersized']);
});

test('BRO-5312: a sufficiently funded job has no residual timeout warning', () => {
  const result = audit.evaluateStep({ maxRetries: 7, deadlineSec: 240, jobTimeoutMinutes: 30 });
  assert.deepEqual(result.advisoryFlags, []);
  assert.equal(result.marginWithResidualSec, 760);
});

test('BRO-5312: residual is added even when backoff is larger than the deadline', () => {
  const result = audit.evaluateStep({ maxRetries: 50, deadlineSec: 300, jobTimeoutMinutes: 60 });
  assert.equal(result.stepBudgetSec, 2700);
  assert.equal(result.stepBudgetWithResidualSec, 3500);
});

test('BRO-5312: caller network and operation-floor overrides feed the residual', () => {
  const text = workflow(pushStep('push', `        env:
          GIT_NET_TIMEOUT_SEC: '30'
          PUSH_OP_MIN_TIMEOUT_SEC: '5'
`));
  const [result] = audit.auditWorkflowText(text, 'override.yml');
  assert.equal(result.residualPastDeadlineSec, 470);
  assert.equal(result.stepBudgetWithResidualSec, 710);
});

test('BRO-5312: clamped operations cannot exceed the network cap', () => {
  assert.equal(audit.computeResidualPastDeadlineSec({ gitNetTimeoutSec: 5, opMinTimeoutSec: 20 }), 370);
  assert.equal(audit.computeResidualPastDeadlineSec({ opMinTimeoutSec: 0 }), 800, 'zero floor uses the script default');
});

test('BRO-5312: uncapped sibling pushes include their own residuals', () => {
  const results = audit.auditWorkflowText(workflow(pushStep('one') + pushStep('two')), 'siblings.yml');
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.otherStepsBudgetSec, 240);
    assert.equal(result.otherStepsBudgetWithResidualSec, 1040);
    assert.equal(result.marginWithResidualSec, -280);
    assert.ok(!result.flags.includes('job-timeout-margin-undersized'));
    assert.equal(result.advisoryFlags.length, 1);
  }
});

test('BRO-5312: explicit sibling caps count once even with multiple push calls', () => {
  const text = workflow(pushStep('one') + `      - name: capped
        timeout-minutes: 2
        run: |
          bash scripts/lib/push-with-retry.sh
          bash scripts/lib/push-with-retry.sh
`);
  const [result] = audit.auditWorkflowText(text, 'capped.yml');
  assert.equal(result.otherStepsBudgetSec, 120);
  assert.equal(result.otherStepsBudgetWithResidualSec, 120);
  assert.equal(result.marginWithResidualSec, 640);
});

test('BRO-5312: sequential calls in the same step contribute to the advisory job budget', () => {
  const text = workflow(`      - name: two pushes
        run: |
          bash scripts/lib/push-with-retry.sh
          bash scripts/lib/push-with-retry.sh
`);
  const results = audit.auditWorkflowText(text, 'same-step.yml');
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.equal(result.otherStepsBudgetSec, 0, 'legacy gate is unchanged');
    assert.equal(result.otherStepsBudgetWithResidualSec, 1040);
    assert.equal(result.marginWithResidualSec, -280);
  }
});

test('BRO-5312: real workflows receive residual budgets without new hard-gate violations', () => {
  for (const file of ['data-health-check.yml', 'rebuild-reviews.yml', 'update-show-status.yml']) {
    const text = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
    const results = audit.auditWorkflowText(text, file);
    assert.ok(results.length > 0, file);
    assert.ok(results.some((r) => r.advisoryFlags.length > 0), `${file} must expose the hidden timeout risk`);
    for (const result of results) {
      assert.ok(result.residualPastDeadlineSec > 0);
      assert.ok(result.stepBudgetWithResidualSec > result.stepBudgetSec);
      assert.ok(!result.flags.includes('job-timeout-margin-undersized'), file);
    }
  }
});

test('BRO-5312: the real CLI lists residual violations in JSON while the hard gate still passes', () => {
  const result = spawnSync(process.execPath, ['scripts/audit-push-retry-budgets.js', '--json', '--fail-on-job-timeout'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.residualJobTimeoutViolationCount > 0);
  assert.equal(report.residualJobTimeoutViolationCount, report.residualJobTimeoutViolations.length);
  assert.ok(report.residualJobTimeoutViolations.some((r) => r.flags.length === 0), 'list callers absent from the legacy ranked report too');
  assert.ok(report.residualJobTimeoutViolations.every((r) => r.advisoryFlags.includes('job-timeout-margin-with-residual-undersized')));
  assert.ok(report.residualJobTimeoutViolations.every((r) => r.marginRatioWithResidual < audit.MARGIN_THRESHOLD));
  assert.ok(report.ranked.every((r) => !r.flags.includes('job-timeout-margin-undersized')));
});

test('BRO-5312: the real CLI prints the advisory warning, budget columns and caller names', () => {
  const result = spawnSync(process.execPath, ['scripts/audit-push-retry-budgets.js', '--top=1'], {
    cwd: new URL('../../', import.meta.url), encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Warning \(advisory only, BRO-5312\)/);
  assert.match(result.stdout, /residualPastDeadline=\d+s stepBudgetWithResidual=\d+s/);
  assert.match(result.stdout, /\.yml :: .+ \/ "/);
  assert.match(result.stdout, /--json for the full caller list/);
});
