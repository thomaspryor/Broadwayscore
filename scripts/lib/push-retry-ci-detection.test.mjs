/**
 * Card #1901 acceptance test: a GITHUB_ACTIONS=true environment must produce
 * ci:true in the push-retry-failures ledger record. Tests the real functions
 * (scripts/lib/push-ledger.js) per CLAUDE.md's test-extraction rule — no
 * logic is re-implemented here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isGithubActionsRunner, buildFailureEntry } = require('./push-ledger.js');

test('isGithubActionsRunner: GITHUB_ACTIONS=true -> true', () => {
  assert.equal(isGithubActionsRunner({ GITHUB_ACTIONS: 'true' }), true);
});

test('isGithubActionsRunner: no CI env vars (local run) -> false', () => {
  assert.equal(isGithubActionsRunner({}), false);
});

test('isGithubActionsRunner: defaults to process.env when no arg given', () => {
  const prev = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = 'true';
  try {
    assert.equal(isGithubActionsRunner(), true);
  } finally {
    if (prev === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prev;
  }
});

test('buildFailureEntry: GITHUB_ACTIONS=true environment produces ci:true in the ledger record', () => {
  const ci = isGithubActionsRunner({ GITHUB_ACTIONS: 'true' });
  const line = buildFailureEntry({ reason: 'retries-exhausted', attempt: 7, maxRetries: 7, ci });
  assert.equal(JSON.parse(line).ci, true);
});

test('buildFailureEntry: a local (non-CI) environment produces ci:false in the ledger record', () => {
  const ci = isGithubActionsRunner({});
  const line = buildFailureEntry({ reason: 'retries-exhausted', attempt: 7, maxRetries: 7, ci });
  assert.equal(JSON.parse(line).ci, false);
});
