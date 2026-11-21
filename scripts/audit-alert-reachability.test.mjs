import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getJobBlocks,
  stepCanHardFail,
  stepIfSurvivesEarlierFailure,
  extractRouteAlertCalls,
  isPageWorthyLiteralPrefix,
  findUnreachableAlerts,
  findDowngradedHumanAlerts,
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

// Adversarial review (BRO-2817): a trailing comment after `|| true` must not
// make the line read as unguarded — `cmd || true` and `cmd || true  # why`
// are equally guarded.
test('stepCanHardFail is false when a || true-guarded line has a trailing comment', () => {
  assert.equal(stepCanHardFail({ run: 'node scripts/check-something.js || true  # explain why' }), false);
});

test('stepCanHardFail is false when the step has continue-on-error: true', () => {
  assert.equal(stepCanHardFail({ run: 'process.exit(1)', continueOnError: true }), false);
});

test('stepCanHardFail is false for a step with no run block (e.g. a `uses:` action)', () => {
  assert.equal(stepCanHardFail({ run: '' }), false);
});

// --- stepIfSurvivesEarlierFailure ---------------------------------------------------------

test('stepIfSurvivesEarlierFailure is true for always() or failure(), false otherwise', () => {
  assert.equal(stepIfSurvivesEarlierFailure({ ifRaw: "always() && steps.x.outputs.y != ''" }), true);
  // Adversarial review (BRO-2817): a step gated on `if: failure()` alone (the
  // real shape in .github/workflows/recover-wsj-subscriber.yml:171) is also
  // reachable after an earlier hard-fail — it runs BECAUSE of that failure,
  // which is exactly the scenario this audit cares about.
  assert.equal(stepIfSurvivesEarlierFailure({ ifRaw: 'failure()' }), true);
  assert.equal(stepIfSurvivesEarlierFailure({ ifRaw: "steps.x.outputs.y != ''" }), false);
  assert.equal(stepIfSurvivesEarlierFailure({ ifRaw: null }), false);
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
  assert.equal(isPageWorthyLiteralPrefix('t1-coverage:scoreboard'), false);
  assert.equal(isPageWorthyLiteralPrefix('cron-health-chronic:'), false);
});

test('test-yml:main-streak-escalation no longer pages the owner (BRO-4141: red trunk goes to the digest)', () => {
  assert.equal(isPageWorthyLiteralPrefix('test-yml:main-streak-escalation'), false);
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
    '      - name: Coverage scoreboard',
    '        run: |',
    "          node -e \"routeAlert({ conditionKey: 't1-coverage:scoreboard', disposition: 'human' })\"",
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

// --- BRO-7102: 'human' alerts whose key can never page -----------------------

// Baseline at BRO-7102 (2026-11-08). Each of these is downgraded to the digest on
// every fire. Shrinking this list is welcome; a NEW entry fails: write
// disposition 'digest' (or 'auto' for a card) instead, or make the key
// page-worthy in scripts/lib/page-worthy-alerts.js (an owner call, BRO-4141).
const DOWNGRADED_HUMAN_BASELINE = new Set([
  '.github/workflows/update-mezzanine.yml :: mezzanine:session-token-expired',
  '.github/workflows/update-show-status.yml :: update-show-status:repeat-failure',
  'scripts/audit-opening-night-coverage.js :: t1-coverage:new-gaps-24h',
  'scripts/audit-show-review-gap.js :: we-gate:enabled-delayed-notice',
  'scripts/audit-show-review-gap.js :: we-gate:proven-variable-already-set',
  'scripts/lib/broadcast-gate-alert.js :: broadcast-gate:',
  'scripts/replay-pending-bylines.js :: ',
]);

test('no NEW routeAlert uses disposition human with a key that can never page (BRO-7102)', () => {
  const found = findDowngradedHumanAlerts().map((f) => `${f.file} :: ${f.conditionKey}`);
  const fresh = [...new Set(found)].filter((k) => !DOWNGRADED_HUMAN_BASELINE.has(k));
  assert.deepEqual(fresh, [], `these 'human' alerts can never page and would silently become digest lines: ${fresh.join('; ')}`);
});

test('the retired main-streak escalation is no longer a downgraded human alert (BRO-7102)', () => {
  const found = findDowngradedHumanAlerts();
  assert.ok(found.length > 0, 'scanner found nothing: it is not reading the corpus');
  assert.equal(found.some((f) => f.conditionKey.startsWith('test-yml:main-streak')), false);
});
