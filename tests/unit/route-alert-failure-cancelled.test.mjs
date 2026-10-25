import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { findInlineAlertCalls, findInlineAlertSteps, findFailureOnlyPagingAlerts, findBlockedPagingCheckouts } = require('../../scripts/lib/route-alert-failure-cancelled');
const workflowsDir = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));
const router = "const { routeAlert } = require('./scripts/lib/owner-alert-router.js');";
const sender = "const { sendAlert } = require('./scripts/lib/discord-notify.js');";

test('uses real router disposition/key policy, including promoted warning severity', () => {
  const calls = findInlineAlertCalls(`${router}
    await routeAlert({ conditionKey: 'alert-router:deadman', disposition: 'human', severity: 'warning' });
    await routeAlert({ conditionKey: 'alert-router:deadman', disposition: 'digest', severity: 'critical' });
    await routeAlert({ conditionKey: 'alert-router:deadman', disposition: 'auto', severity: 'error' });
    await routeAlert({ conditionKey: 'mezzanine:session-token-expired', disposition: 'human', severity: 'error' });
  `);
  assert.deepEqual(calls.map(c => c.immediateEmail), [true, false, false, false]);
});

test('direct sendAlert requires email and emailable severity, including defaults', () => {
  const calls = findInlineAlertCalls(`${sender}
    sendAlert({ email: true, severity: 'critical' });
    sendAlert({ email: true, severity: 'error' });
    sendAlert({ email: true });
    sendAlert({ email: true, severity: 'warning' });
    sendAlert({ email: true, severity: 'info' });
    sendAlert({ severity: 'critical' });
    sendAlert({ email: false, severity: 'error' });
  `);
  assert.deepEqual(calls.map(c => c.immediateEmail), [true, true, true, false, false, false, false]);
});

test('does not confuse comments, strings, unrelated functions or neighboring objects with calls', () => {
  assert.deepEqual(findInlineAlertCalls(`${sender}
    // sendAlert({ email: true, severity: 'critical' });
    const description = "routeAlert({ disposition: 'human' })";
    other({ email: true, severity: 'critical' });
  `), []);
  const calls = findInlineAlertCalls(`${sender}
    sendAlert({ severity: 'warning' });
    other({ email: true, severity: 'critical' });
  `);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].immediateEmail, false);
});

test('recognizes aliased and namespace imports and conservatively includes dynamic options', () => {
  const calls = findInlineAlertCalls(`
    const { routeAlert: page } = require('./scripts/lib/owner-alert-router');
    const notify = require('./scripts/lib/discord-notify.js');
    page({ conditionKey: process.env.KEY, disposition: 'human' });
    notify.sendAlert({ ...options });
    notify.sendAlert({ ...options, email: false });
  `);
  assert.deepEqual(calls.map(c => c.immediateEmail), [true, true, false]);
});

test('self-registers new workflow files and detects failure-only and negated cancellation gates', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'route-alert-cancelled-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paging = `${router} routeAlert({ conditionKey: 'alert-router:deadman', disposition: 'human' });`;
  const step = condition => ({ name: condition, if: condition, uses: 'actions/github-script@v7', with: { script: paging } });
  fs.writeFileSync(path.join(dir, 'new-workflow.yaml'), yaml.dump({ jobs: { page: { steps: [
    { uses: 'actions/checkout@v4' },
    step('failure()'),
    step("failure() && github.ref == 'refs/heads/main'"),
    step('failure() || !cancelled()'),
    step('failure() && cancelled()'),
    step('failure() || cancelled()'),
    step('${{ (failure() || cancelled()) && inputs.alert }}'),
    step('always()'),
    step('failure() || always()'),
    { ...step('failure()'), with: { script: `${sender} sendAlert({ severity: 'warning' });` } },
  ] } } }));
  const entries = findInlineAlertSteps(dir, yaml.load);
  assert.equal(entries.length, 9);
  assert.deepEqual(findFailureOnlyPagingAlerts(entries).map(e => e.if), [
    'failure()', "failure() && github.ref == 'refs/heads/main'", 'failure() || !cancelled()', 'failure() && cancelled()',
  ]);
  assert.deepEqual(findBlockedPagingCheckouts(entries), []);
});

test('conditional checkout must also be reachable for cancellation alerts', () => {
  const paging = { immediateEmail: true };
  const entry = { calls: [paging], if: 'failure() || cancelled()', index: 1, steps: [
    { uses: 'actions/checkout@v4', if: 'failure()' }, {},
  ] };
  assert.equal(findBlockedPagingCheckouts([entry]).length, 1);
  entry.steps[0].if = 'inputs.alert';
  assert.equal(findBlockedPagingCheckouts([entry]).length, 1);
  entry.steps[0].if = 'failure() || cancelled()';
  assert.deepEqual(findBlockedPagingCheckouts([entry]), []);
  entry.steps[0].if = 'always()';
  assert.deepEqual(findBlockedPagingCheckouts([entry]), []);
  delete entry.steps[0].if;
  assert.deepEqual(findBlockedPagingCheckouts([entry]), []);
});

test('real inline paging alerts gated on failure also cover cancellation', () => {
  const entries = findInlineAlertSteps(workflowsDir, yaml.load);
  assert.ok(entries.some(e => e.calls.some(c => c.immediateEmail)), 'scan must find real paging callers');
  const format = e => `${e.file} / ${e.jobId} / ${e.name}: ${e.if}`;
  assert.deepEqual(findFailureOnlyPagingAlerts(entries).map(format), [],
    'Real-time email failure alerts need failure() || cancelled()');
  assert.deepEqual(findBlockedPagingCheckouts(entries).map(format), [],
    'Cancellation alerts must be able to require their local modules after checkout');
});
