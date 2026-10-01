import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { isReaderFeedbackIssue, shouldEmailOwnerOnFix } = require('../../scripts/lib/owner-fix-email.js');

test('only reader-feedback issue ids count as reader feedback', () => {
  for (const id of ['504', '504-systematic', 504, ' 925 ']) {
    assert.equal(isReaderFeedbackIssue(id), true, String(id));
  }
  for (const id of ['bro-4431', 'bro-4431-f', 'BRO-4216', 'bro-4259-opening', 'ops-12', '', null, undefined, '504-x']) {
    assert.equal(isReaderFeedbackIssue(id), false, String(id));
  }
});

test('owner is emailed for reader-feedback fixes only', () => {
  const base = { ownerEmail: 'owner@example.com', appliedCount: 2 };
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: '504' }), true);
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: '504-systematic' }), true);
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: 'bro-4431-f' }), false);
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: '504', appliedCount: 0 }), false);
  assert.equal(shouldEmailOwnerOnFix({ ...base, issueNumber: '504', ownerEmail: '' }), false);
});

test('execute-approved-fix.js gates the owner email through the helper', () => {
  const src = fs.readFileSync(new URL('../../scripts/execute-approved-fix.js', import.meta.url), 'utf8');
  assert.match(src, /if \(shouldEmailOwnerOnFix\(/);
  assert.doesNotMatch(src, /if \(ownerEmail && applied\.length > 0\)/);
});
