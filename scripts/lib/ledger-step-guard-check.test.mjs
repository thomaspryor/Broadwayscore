import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { findLedgerStepGuardIssues } = require('./ledger-step-guard-check.js');

// The real, compliant pattern — every one of the repo's 30 existing call
// sites looks like this (verified BRO-2243). Must report clean.
const COMPLIANT_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Commit scraper-spend ledger
        if: always()
        continue-on-error: true
        uses: ./.github/actions/commit-scraper-spend-ledger
        with:
          workflow-name: test-data-validation
`;

// A conditional if: that still includes always() (scrapingdog-account-usage.yml's
// real shape) must also count as compliant — always() combined with another
// predicate is still unconditional-on-failure.
const COMPOUND_IF_FIXTURE = `name: Example
on:
  workflow_dispatch:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Commit scraper-spend ledger
        if: always() && inputs.mode == 'confirm-empty-authoritative'
        continue-on-error: true
        uses: ./.github/actions/commit-scraper-spend-ledger
        with:
          workflow-name: scrapingdog-account-usage
`;

// The exact bug BRO-2243 investigated: this is the shape that would let a
// ledger push race fail the job. Both flags missing.
const MISSING_BOTH_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Commit scraper-spend ledger
        uses: ./.github/actions/commit-scraper-spend-ledger
        with:
          workflow-name: some-workflow
`;

// Only continue-on-error missing — the step would be skipped after an
// earlier failed step (no if: always()) but if it DID run and lost the
// push race, the job would still fail.
const MISSING_CONTINUE_ON_ERROR_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Commit scraper-spend ledger
        if: always()
        uses: ./.github/actions/commit-scraper-spend-ledger
        with:
          workflow-name: some-workflow
`;

// Only if: always() missing — on a job with no earlier failed step this is
// usually fine, but a push race would still fail the job since nothing
// catches it.
const MISSING_IF_ALWAYS_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Commit scraper-spend ledger
        continue-on-error: true
        uses: ./.github/actions/commit-scraper-spend-ledger
        with:
          workflow-name: some-workflow
`;

// A step that doesn't use the ledger action at all must never be flagged,
// regardless of its own if:/continue-on-error: config.
const UNRELATED_STEP_FIXTURE = `name: Example
on:
  push:
jobs:
  x:
    runs-on: ubuntu-latest
    steps:
      - name: Some other step
        run: echo hi
`;

test('compliant ledger step (if: always() + continue-on-error: true) is clean', () => {
  assert.deepEqual(findLedgerStepGuardIssues(COMPLIANT_FIXTURE), []);
});

test('compound if: expression that includes always() is clean', () => {
  assert.deepEqual(findLedgerStepGuardIssues(COMPOUND_IF_FIXTURE), []);
});

test('step missing both flags is flagged, naming both', () => {
  const issues = findLedgerStepGuardIssues(MISSING_BOTH_FIXTURE);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /Commit scraper-spend ledger/);
  assert.match(issues[0], /if: always\(\)/);
  assert.match(issues[0], /continue-on-error: true/);
});

test('step missing only continue-on-error is flagged', () => {
  const issues = findLedgerStepGuardIssues(MISSING_CONTINUE_ON_ERROR_FIXTURE);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /continue-on-error: true/);
  assert.doesNotMatch(issues[0], /if: always\(\) and/);
});

test('step missing only if: always() is flagged', () => {
  const issues = findLedgerStepGuardIssues(MISSING_IF_ALWAYS_FIXTURE);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /if: always\(\)/);
});

test('steps not using the ledger action are never flagged', () => {
  assert.deepEqual(findLedgerStepGuardIssues(UNRELATED_STEP_FIXTURE), []);
});

test('real test.yml data-validation call site is clean', () => {
  const fs = require('fs');
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'test.yml');
  const text = fs.readFileSync(workflowPath, 'utf8');
  assert.deepEqual(findLedgerStepGuardIssues(text), []);
});
