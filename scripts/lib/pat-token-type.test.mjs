import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { classifyPatToken, legacyTokenWarning, FINE_GRAINED_REPOS } = createRequire(import.meta.url)('./pat-token-type.js');

test('classifyPatToken by prefix', () => {
  assert.equal(classifyPatToken('github_pat_11ABC'), 'fine-grained');
  assert.equal(classifyPatToken('ghp_abc'), 'classic');
  assert.equal(classifyPatToken('gho_abc'), 'oauth');
  assert.equal(classifyPatToken(' ghp_abc\n'), 'classic');
  assert.equal(classifyPatToken(''), 'unknown');
  assert.equal(classifyPatToken(undefined), 'unknown');
});

test('legacyTokenWarning warns for classic and oauth only', () => {
  assert.match(legacyTokenWarning('ghp_x'), /still a classic\/all-repo token/);
  assert.match(legacyTokenWarning('gho_x'), /OAuth/);
  assert.equal(legacyTokenWarning('github_pat_x'), null);
  assert.equal(legacyTokenWarning('mystery'), null);
});

test('fine-grained repo list covers the five repos', () => {
  assert.equal(FINE_GRAINED_REPOS.length, 5);
});
