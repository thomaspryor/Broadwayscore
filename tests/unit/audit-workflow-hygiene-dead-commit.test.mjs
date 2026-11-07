// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the regex-detector under
// test never reads data/*.json; "data/shows.json" appears only as a string
// literal inside synthetic YAML fixtures.
/**
 * Unit tests for findDeadCommitSteps (task #1461, generalizes #1460) —
 * catches a job that inline `git commit`s and pushes but never `git add`s
 * anything, the exact bug class found twice by hand (task #1460's own fix,
 * then a 6-workflow cousin sweep).
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findDeadCommitSteps } = require('../../scripts/audit-workflow-hygiene.js');

const synthetic = (body) => `
jobs:
  commit-data:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/checkout-core-data
${body}
`;

describe('findDeadCommitSteps', () => {
  test('flags a job with git commit + push-with-retry.sh and no git add anywhere', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          git commit -m "data: update"
          bash scripts/lib/push-with-retry.sh
`);
    const violations = findDeadCommitSteps(raw);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].job, 'commit-data');
  });

  test('does NOT flag when a git add is present', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          git add data/shows.json
          git commit -m "data: update"
          bash scripts/lib/push-with-retry.sh
`);
    const violations = findDeadCommitSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag when a shared git-add-satisfying script is invoked instead', () => {
    const raw = synthetic(`
      - name: Stage and commit
        run: |
          bash scripts/lib/stage-data-changes.sh
          git commit -m "data: update"
          bash scripts/lib/push-with-retry.sh
`);
    const violations = findDeadCommitSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('flags a job with bare git push (no push-with-retry.sh) and no git add', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          git commit -m "data: update"
          git push origin main
`);
    const violations = findDeadCommitSteps(raw);
    assert.strictEqual(violations.length, 1);
  });

  test('does NOT flag a job with git commit but no push step (never dead, just uncommitted work)', () => {
    const raw = synthetic(`
      - name: Commit only
        run: |
          git commit -m "data: update"
`);
    const violations = findDeadCommitSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag a job with a push step but no git commit', () => {
    const raw = synthetic(`
      - name: Push
        run: bash scripts/lib/push-with-retry.sh
`);
    const violations = findDeadCommitSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag a commented-out git commit (reference in a comment, not real code)', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          # A prior \`git commit -m "..."\` step was removed here.
          bash scripts/lib/push-with-retry.sh
`);
    const violations = findDeadCommitSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('git add in a DIFFERENT job does not satisfy the same-job requirement', () => {
    const raw = `
jobs:
  stager:
    runs-on: ubuntu-latest
    steps:
      - name: Add
        run: git add data/shows.json
  committer:
    runs-on: ubuntu-latest
    steps:
      - name: Commit
        run: |
          git commit -m "data: update"
          bash scripts/lib/push-with-retry.sh
`;
    const violations = findDeadCommitSteps(raw);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].job, 'committer');
  });

  test('does NOT flag inline `- run: <cmd>` list-item shorthand for git add (ship-check finding)', () => {
    const raw = synthetic(`
      - run: git add data/shows.json
      - name: Commit
        run: |
          git commit -m "data: update"
          bash scripts/lib/push-with-retry.sh
`);
    const violations = findDeadCommitSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('flags when a commit message merely mentions a staging-script filename (ship-check finding)', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          git commit -m "Fixed per stage-data-changes.sh review notes"
          bash scripts/lib/push-with-retry.sh
`);
    const violations = findDeadCommitSteps(raw);
    assert.strictEqual(violations.length, 1);
  });

  test('does NOT flag a real staging-script invocation (full scripts/lib/ path)', () => {
    const raw = synthetic(`
      - name: Stage and commit
        run: |
          bash scripts/lib/stage-data-changes.sh
          git commit -m "data: update"
          bash scripts/lib/push-with-retry.sh
`);
    const violations = findDeadCommitSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('a git commit inside a `uses:` composite action call is not treated as inline', () => {
    const raw = synthetic(`
      - name: Push core data
        uses: ./.github/actions/push-core-data
        with:
          token: \${{ secrets.REVIEW_TEXTS_TOKEN }}
          message: 'git commit -m data update'
`);
    const violations = findDeadCommitSteps(raw);
    assert.deepStrictEqual(violations, []);
  });
});
