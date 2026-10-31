/**
 * land-alert.test.mjs — drives the REAL buildLandAlert()/sendLandAlert()/
 * resolveLandAlert() (rule 15: require(), never a copy) with the router
 * injected, so no ledger is ever touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { conditionKeyFor, buildLandAlert, sendLandAlert, resolveLandAlert, DEFAULT_COOLDOWN_HOURS } = require('./land-alert.js');

test('conditionKeyFor: one stable key per branch, refs/heads/ stripped', () => {
  assert.equal(conditionKeyFor('land/foo'), 'land:land/foo');
  assert.equal(conditionKeyFor('refs/heads/land/foo'), 'land:land/foo');
});

test('buildLandAlert: digest disposition, gate + branch in the title, ref-kept wording, clipped detail', () => {
  const a = buildLandAlert({
    branch: 'refs/heads/land/test-red',
    gate: 'unit-tests',
    runUrl: 'https://github.com/x/y/actions/runs/1',
    sha: '0123456789abcdef0123456789abcdef01234567',
    detail: `not ok 1 - boom\n${'x'.repeat(1000)}`,
  });
  assert.equal(a.conditionKey, 'land:land/test-red');
  assert.equal(a.disposition, 'digest');
  assert.equal(a.severity, 'error');
  assert.equal(a.cooldownHours, DEFAULT_COOLDOWN_HOURS);
  assert.equal(a.title, 'Landing blocked: unit-tests red on land/test-red');
  assert.match(a.description, /unit-tests gate went red at 0123456789/);
  assert.match(a.description, /ref was left in place and nothing was pushed/);
  assert.match(a.description, /Run: https:\/\/github\.com\/x\/y\/actions\/runs\/1/);
  assert.ok(a.description.length < 700, `description should be clipped, got ${a.description.length}`);
  assert.match(a.hint, /gh api -X DELETE .*refs\/heads\/land\/test-red/);
  assert.deepEqual(a.fields.map(f => f.name), ['branch', 'gate', 'tip', 'run']);
});

test('buildLandAlert refuses a missing branch or gate', () => {
  assert.throws(() => buildLandAlert({ gate: 'tsc' }), /requires branch/);
  assert.throws(() => buildLandAlert({ branch: 'land/x' }), /requires gate/);
});

test('sendLandAlert routes the built alert through the injected router', async () => {
  const seen = [];
  const res = await sendLandAlert({ branch: 'land/x', gate: 'tsc' }, { route: async (o) => { seen.push(o); return { action: 'digest' }; } });
  assert.deepEqual(res, { action: 'digest' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].conditionKey, 'land:land/x');
  assert.equal(seen[0].disposition, 'digest');
});

test('resolveLandAlert resolves exactly the branch condition', () => {
  const seen = [];
  resolveLandAlert('refs/heads/land/x', { resolve: (k) => { seen.push(k); return true; } });
  assert.deepEqual(seen, ['land:land/x']);
});
