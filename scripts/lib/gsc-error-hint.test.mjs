/**
 * gsc-error-hint.test.mjs — the hint printed when a Search Console API call
 * fails (BRO-5961). Per CLAUDE.md §15 it require()s the real function.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeGscError } = require('./gsc-error-hint.js');

const EMAIL = 'seo-bot@demo-project.iam.gserviceaccount.com';
// Body shape copied from check-seo-health.yml run 39126497556 (2026-10-18).
const PERMISSION_403 = JSON.stringify({ error: { code: 403, message: "User does not have sufficient permission for site 'sc-domain:broadwayscorecard.com'. See also: https://support.google.com/webmasters/answer/2451999.", errors: [{ reason: 'forbidden' }] } });
const DISABLED_403 = JSON.stringify({ error: { code: 403, message: 'Google Search Console API has not been used in project 123 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } });

test('a dropped service account names the address to re-add', () => {
  const hint = describeGscError(403, PERMISSION_403, EMAIL);
  assert.match(hint, new RegExp(EMAIL.replace(/[.@]/g, '\\$&')));
  assert.match(hint, /Manage property owners → Add an owner/);
});

test('a disabled API points at the Cloud console, not at Search Console users', () => {
  const hint = describeGscError(403, DISABLED_403, EMAIL);
  assert.match(hint, /enable "Google Search Console API"/);
  assert.doesNotMatch(hint, /Add an owner/);
});

test('a missing client_email still produces a usable hint', () => {
  assert.match(describeGscError(403, PERMISSION_403, undefined), /GOOGLE_INDEXING_KEY/);
});

test('other failures get no hint', () => {
  assert.equal(describeGscError(500, 'backend error', EMAIL), null);
  assert.equal(describeGscError(403, 'quota exceeded', EMAIL), null);
  assert.equal(describeGscError(404, PERMISSION_403, EMAIL), null);
});
