/**
 * record-push-ledger-redaction.test.mjs — task #1742.
 *
 * Data-repo clones are cloned with a credential-embedded remote
 * (https://x-access-token:<token>@github.com/...). record-push-ledger.js
 * used to print that URL verbatim when skipping a non-canonical repo,
 * leaking the live token into any log that captures the run.
 * redactRemoteUrl() strips the userinfo segment before the URL reaches
 * console.log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { redactRemoteUrl } = require('../record-push-ledger.js');

test('redactRemoteUrl strips an embedded GitHub token from an https remote URL', () => {
  const redacted = redactRemoteUrl('https://x-access-token:gho_SECRET@github.com/o/r.git');
  assert.ok(!redacted.includes('gho_SECRET'), `redacted URL still contains the token: ${redacted}`);
  assert.equal(redacted, 'https://github.com/o/r.git');
});

test('redactRemoteUrl leaves a plain https remote URL (no credentials) unchanged', () => {
  assert.equal(redactRemoteUrl('https://github.com/o/r.git'), 'https://github.com/o/r.git');
});

test('redactRemoteUrl leaves an ssh remote URL unchanged', () => {
  assert.equal(redactRemoteUrl('git@github.com:o/r.git'), 'git@github.com:o/r.git');
});

test('redactRemoteUrl passes through empty/falsy input unchanged', () => {
  assert.equal(redactRemoteUrl(''), '');
  assert.equal(redactRemoteUrl(undefined), undefined);
});
