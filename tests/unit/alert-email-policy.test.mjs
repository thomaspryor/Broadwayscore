/**
 * Actionable-only email policy (2026-07-11, owner request after 305 alert
 * emails): only severity 'critical'/'error' may email; 'warning'/'info' are
 * log + step-summary only. Enforced inside sendEmailAlert so direct callers
 * (e.g. promote-ob-venue-candidates.js) can't bypass it, and sendAlert must
 * not report a policy suppression as a delivery failure (::error::).
 *
 * Run: node --test tests/unit/alert-email-policy.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Ensure no accidental real sends if env leaks keys into the test runner.
delete process.env.RESEND_API_KEY;
delete process.env.OWNER_EMAIL;
delete process.env.GITHUB_STEP_SUMMARY;

const { shouldEmailAlert, sendEmailAlert, sendAlert } = require('../../scripts/lib/discord-notify.js');

test('shouldEmailAlert: only critical and error are emailable', () => {
  assert.equal(shouldEmailAlert('critical'), true);
  assert.equal(shouldEmailAlert('error'), true);
  assert.equal(shouldEmailAlert('warning'), false);
  assert.equal(shouldEmailAlert('info'), false);
  assert.equal(shouldEmailAlert(undefined), false);
  assert.equal(shouldEmailAlert('low'), false);
});

test('sendEmailAlert: warning/info suppressed BEFORE the missing-key check', async () => {
  // With keys deleted, an attempted send logs "[Email] ... not set"; a
  // policy-suppressed send logs "[Alert policy]". Capture to distinguish.
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const sent = await sendEmailAlert({ title: 't', description: 'd', severity: 'warning' });
    assert.equal(sent, false);
    assert.ok(logs.some(l => l.includes('[Alert policy] email suppressed')), 'policy log expected');
    assert.ok(!logs.some(l => l.includes('RESEND_API_KEY')), 'must not reach the send path');
  } finally {
    console.log = orig;
  }
});

test('sendEmailAlert: error severity proceeds to the send path (fails only on missing keys)', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const sent = await sendEmailAlert({ title: 't', description: 'd', severity: 'error' });
    assert.equal(sent, false, 'no keys in test env — delivery fails');
    assert.ok(logs.some(l => l.includes('RESEND_API_KEY')), 'reached the send path');
    assert.ok(!logs.some(l => l.includes('[Alert policy]')), 'not policy-suppressed');
  } finally {
    console.log = orig;
  }
});

test('sendAlert: policy suppression does NOT fire the ::error:: delivery-failed annotation', async () => {
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const delivered = await sendAlert({ title: 't', description: 'd', severity: 'warning', email: true });
    assert.equal(delivered, false);
    assert.ok(!errs.some(l => l.includes('alert delivery FAILED')),
      'suppression must not be reported as a delivery failure');
  } finally {
    console.error = orig;
  }
});
