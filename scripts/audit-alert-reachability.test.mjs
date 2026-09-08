import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getJobBlocks,
  stepCanHardFail,
  stepIfHasAlways,
  extractRouteAlertCalls,
  isPageWorthyLiteralPrefix,
  findUnreachableAlerts,
  collectFindings,
} = require('./audit-alert-reachability.js');

// --- getJobBlocks ------------------------------------------------------------

function workflowFixture(stepsYaml) {
  return [
    'name: Fixture',
    'on: workflow_dispatch',
    'jobs:',
    '  main:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    stepsYaml,
  ].join('\n');
}

test('getJobBlocks parses step name, if, continue-on-error, and a block-scalar run body', () => {
  const raw = workflowFixture([
    '      - name: Gate',
    "        if: steps.check.outputs.pending != ''",
    '        run: |',
    "          node -e \"process.exit(1)\"",
    '      - name: Alert',
    '        run: echo hi',
  ].join('\n'));
  const [job] = getJobBlocks(raw);
  assert.equal(job.name, 'main');
  assert.equal(job.steps.length, 2);
  assert.equal(job.steps[0].name, 'Gate');
  assert.equal(job.steps[0].ifRaw, "steps.check.outputs.pending != ''");
  assert.match(job.steps[0].run, /process\.exit\(1\)/);
  assert.equal(job.steps[1].name, 'Alert');
  assert.equal(job.steps[1].run, 'echo hi');
});

test('getJobBlocks captures continue-on-error: true', () => {
  const raw = workflowFixture([
    '      - name: Soft step',
    '        continue-on-error: true',
    '        run: exit 1',
  ].join('\n'));
  const [job] = getJobBlocks(raw);
  assert.equal(job.steps[0].continueOnError, true);
});

// --- stepCanHardFail ---------------------------------------------------------

test('stepCanHardFail is true for a run block containing process.exit(1)', () => {
  assert.equal(stepCanHardFail({ run: 'node -e "process.exit(1)"' }), true);
});

test('stepCanHardFail is true for a bare unguarded command', () => {
  assert.equal(stepCanHardFail({ run: 'node scripts/check-something.js' }), true);
});

test('stepCanHardFail is false when every line is || true-guarded', () => {
  assert.equal(stepCanHardFail({ run: 'node scripts/check-something.js || true' }), false);
});

test('stepCanHardFail is false when the step has continue-on-error: true', () => {
  assert.equal(stepCanHardFail({ run: 'process.exit(1)', continueOnError: true }), false);
});

test('stepCanHardFail is false for a step with no run block (e.g. a `uses:` action)', () => {
  assert.equal(stepCanHardFail({ run: '' }), false);
});

// --- stepIfHasAlways ---------------------------------------------------------

test('stepIfHasAlways is true only when the if condition contains always()', () => {
  assert.equal(stepIfHasAlways({ ifRaw: "always() && steps.x.outputs.y != ''" }), true);
  assert.equal(stepIfHasAlways({ ifRaw: "steps.x.outputs.y != ''" }), false);
  assert.equal(stepIfHasAlways({ ifRaw: null }), false);
});

// --- extractRouteAlertCalls ---------------------------------------------------

test('extractRouteAlertCalls extracts the literal prefix from a string-concatenated conditionKey', () => {
  const run = `
    routeAlert({
      conditionKey: 'broadcast:overdue:' + (process.env.OVERDUE_IDS || 'unknown'),
      disposition: 'human',
    });
  `;
  const calls = extractRouteAlertCalls(run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conditionKeyLiteral, 'broadcast:overdue:');
  assert.equal(calls[0].disposition, 'human');
});

test('extractRouteAlertCalls extracts the literal prefix from a template-literal conditionKey', () => {
  const run = `
    routeAlert({
      conditionKey: \`cron-health-chronic:\${name}\`,
      disposition: 'auto',
    });
  `;
  const calls = extractRouteAlertCalls(run);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conditionKeyLiteral, 'cron-health-chronic:');
  assert.equal(calls[0].disposition, 'auto');
});

test('extractRouteAlertCalls handles a plain literal conditionKey with no concatenation', () => {
  const run = `
    routeAlert({
      conditionKey: 'test-yml:main-streak-escalation',
      disposition: 'human',
    });
  `;
  const calls = extractRouteAlertCalls(run);
  assert.equal(calls[0].conditionKeyLiteral, 'test-yml:main-streak-escalation');
});

test('extractRouteAlertCalls handles multiple calls in one run block', () => {
  const run = `
    routeAlert({ conditionKey: 'a', disposition: 'digest' });
    routeAlert({ conditionKey: 'b', disposition: 'human' });
  `;
  const calls = extractRouteAlertCalls(run);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].disposition, 'digest');
  assert.equal(calls[1].disposition, 'human');
});

// --- isPageWorthyLiteralPrefix ------------------------------------------------

test('isPageWorthyLiteralPrefix matches a known PAGE_WORTHY_PREFIXES entry', () => {
  assert.equal(isPageWorthyLiteralPrefix('broadcast:overdue:'), true);
});

test('isPageWorthyLiteralPrefix matches a known PAGE_WORTHY_CONDITION_KEYS exact entry', () => {
  assert.equal(isPageWorthyLiteralPrefix('alert-router:deadman'), true);
});

test('isPageWorthyLiteralPrefix is false for an unrelated key', () => {
  assert.equal(isPageWorthyLiteralPrefix('test-yml:main-streak-escalation'), false);
  assert.equal(isPageWorthyLiteralPrefix('cron-health-chronic:'), false);
});

// --- findUnreachableAlerts: the 3 acceptance-criteria fixture cases ----------

test('(a) a page-worthy human alert after a hard-fail gate with no always() is flagged', () => {
  const raw = workflowFixture([
    '      - name: Checklist gate',
    '        run: |',
    '          node -e "process.exit(1)"',
    '      - name: Alert if broadcast overdue',
    "        if: steps.check.outputs.pending != ''",
    '        run: |',
    "          node -e \"require('./scripts/lib/owner-alert-router').routeAlert({ conditionKey: 'broadcast:overdue:' + ids, disposition: 'human' })\"",
  ].join('\n'));
  const findings = findUnreachableAlerts(getJobBlocks(raw));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].step, 'Alert if broadcast overdue');
  assert.equal(findings[0].conditionKey, 'broadcast:overdue:');
});

test('(b) the same shape with if: always() on the alert step is clean', () => {
  const raw = workflowFixture([
    '      - name: Checklist gate',
    '        run: |',
    '          node -e "process.exit(1)"',
    '      - name: Alert if broadcast overdue',
    "        if: always() && steps.check.outputs.pending != ''",
    '        run: |',
    "          node -e \"require('./scripts/lib/owner-alert-router').routeAlert({ conditionKey: 'broadcast:overdue:' + ids, disposition: 'human' })\"",
  ].join('\n'));
  const findings = findUnreachableAlerts(getJobBlocks(raw));
  assert.deepEqual(findings, []);
});

test('(c) a non-page-worthy alert after a hard-fail gate is not flagged (digest-tier alerts are not noisy)', () => {
  const raw = workflowFixture([
    '      - name: Some gate',
    '        run: |',
    '          node -e "process.exit(1)"',
    '      - name: Streak escalation',
    '        run: |',
    "          node -e \"routeAlert({ conditionKey: 'test-yml:main-streak-escalation', disposition: 'human' })\"",
  ].join('\n'));
  const findings = findUnreachableAlerts(getJobBlocks(raw));
  assert.deepEqual(findings, []);
});

test('does not flag when there is no earlier hard-fail step at all', () => {
  const raw = workflowFixture([
    '      - name: Harmless setup',
    '        run: echo hi || true',
    '      - name: Alert if broadcast overdue',
    '        run: |',
    "          routeAlert({ conditionKey: 'broadcast:overdue:' + ids, disposition: 'human' })",
  ].join('\n'));
  const findings = findUnreachableAlerts(getJobBlocks(raw));
  assert.deepEqual(findings, []);
});

test('does not flag a disposition other than human even with a page-worthy-looking key', () => {
  const raw = workflowFixture([
    '      - name: Gate',
    '        run: process.exit(1)',
    '      - name: Auto alert',
    '        run: |',
    "          routeAlert({ conditionKey: 'broadcast:overdue:' + ids, disposition: 'auto' })",
  ].join('\n'));
  const findings = findUnreachableAlerts(getJobBlocks(raw));
  assert.deepEqual(findings, []);
});

test('an earlier gate with continue-on-error: true does not make later alerts unreachable', () => {
  const raw = workflowFixture([
    '      - name: Gate',
    '        continue-on-error: true',
    '        run: process.exit(1)',
    '      - name: Alert if broadcast overdue',
    '        run: |',
    "          routeAlert({ conditionKey: 'broadcast:overdue:' + ids, disposition: 'human' })",
  ].join('\n'));
  const findings = findUnreachableAlerts(getJobBlocks(raw));
  assert.deepEqual(findings, []);
});

// --- collectFindings: end-to-end regression against the live corpus ---------

test('collectFindings reports zero findings against the live .github/workflows/ corpus', () => {
  const { findings } = collectFindings();
  assert.deepEqual(findings, []);
});
