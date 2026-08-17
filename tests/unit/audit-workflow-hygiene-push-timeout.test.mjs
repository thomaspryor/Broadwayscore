// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the regex-detector under
// test never reads data/*.json; "data/shows.json" appears only as a string
// literal inside synthetic YAML fixtures.
/**
 * Unit tests for findShortPushTimeoutSteps (rule (i), BRO-386) — catches a
 * step that calls push-with-retry.sh but sets timeout-minutes at or below
 * the script's own internal push deadline, leaving no buffer for the step
 * to be killed mid-rebase before the script's own graceful exit fires.
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findShortPushTimeoutSteps } = require('../../scripts/audit-workflow-hygiene.js');

const synthetic = (body) => `
jobs:
  commit-data:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/checkout-core-data
${body}
`;

describe('findShortPushTimeoutSteps', () => {
  test('flags a step with timeout-minutes below the 4-minute default push deadline', () => {
    const raw = synthetic(`
      - name: Commit
        timeout-minutes: 3
        run: |
          git add data/shows.json
          git commit -m "data: update"
          bash scripts/lib/push-with-retry.sh
`);
    const violations = findShortPushTimeoutSteps(raw);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].name, 'Commit');
    assert.strictEqual(violations[0].timeoutMin, 3);
    assert.strictEqual(violations[0].deadlineSec, 240);
  });

  test('flags a step with timeout-minutes exactly equal to the deadline (zero buffer)', () => {
    const raw = synthetic(`
      - name: Commit
        timeout-minutes: 4
        run: bash scripts/lib/push-with-retry.sh
`);
    const violations = findShortPushTimeoutSteps(raw);
    assert.strictEqual(violations.length, 1);
  });

  test('does NOT flag a step with timeout-minutes safely above the deadline', () => {
    const raw = synthetic(`
      - name: Commit
        timeout-minutes: 5
        run: bash scripts/lib/push-with-retry.sh
`);
    const violations = findShortPushTimeoutSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag a step with no explicit timeout-minutes (inherits job-level, different concern)', () => {
    const raw = synthetic(`
      - name: Commit
        run: bash scripts/lib/push-with-retry.sh
`);
    const violations = findShortPushTimeoutSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag a step with a tight timeout that does NOT call push-with-retry.sh', () => {
    const raw = synthetic(`
      - name: Quick check
        timeout-minutes: 2
        run: node scripts/check-something.js
`);
    const violations = findShortPushTimeoutSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('respects an inline PUSH_DEADLINE_SEC override on the push line', () => {
    const raw = synthetic(`
      - name: Commit
        timeout-minutes: 8
        run: |
          git add data/shows.json
          git commit -m "data: update"
          PUSH_DEADLINE_SEC=600 bash scripts/lib/push-with-retry.sh
`);
    const violations = findShortPushTimeoutSteps(raw);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].deadlineSec, 600);
  });

  test('does NOT flag when timeout-minutes covers an overridden (larger) deadline', () => {
    const raw = synthetic(`
      - name: Commit
        timeout-minutes: 12
        run: PUSH_DEADLINE_SEC=600 bash scripts/lib/push-with-retry.sh
`);
    const violations = findShortPushTimeoutSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag a commented-out push-with-retry.sh reference', () => {
    const raw = synthetic(`
      - name: Commit
        timeout-minutes: 2
        run: |
          # bash scripts/lib/push-with-retry.sh (removed, see #1234)
          echo "no-op"
`);
    const violations = findShortPushTimeoutSteps(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('multiple steps in one job: only the short-timeout push step is flagged', () => {
    const raw = synthetic(`
      - name: Quick check
        timeout-minutes: 1
        run: node scripts/check-something.js
      - name: Commit A
        timeout-minutes: 2
        run: bash scripts/lib/push-with-retry.sh
      - name: Commit B
        timeout-minutes: 6
        run: bash scripts/lib/push-with-retry.sh
`);
    const violations = findShortPushTimeoutSteps(raw);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].name, 'Commit A');
  });
});
