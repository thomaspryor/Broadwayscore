// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the regex-detector under
// test never reads data/*.json; "data/awards.json"/"data/shows.json" appear
// only as string literals inside synthetic YAML fixtures.
/**
 * Unit tests for findCoreFileWritesWithoutPush / getCoreFilesFromPushAction
 * (task #1442) — catches a workflow that `git add`s a push-core-data
 * CORE_FILES path but never calls push-core-data in the same job, the exact
 * bug class fixed in task #1441 (update-tony-awards.yml).
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findCoreFileWritesWithoutPush, getCoreFilesFromPushAction } = require(
  '../../scripts/audit-workflow-hygiene.js',
);

const CORE_FILES = ['shows.json', 'awards.json'];

const synthetic = (body) => `
jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/checkout-core-data
${body}
`;

describe('getCoreFilesFromPushAction', () => {
  test('reads the live CORE_FILES list from push-core-data/action.yml', () => {
    const files = getCoreFilesFromPushAction();
    assert.ok(Array.isArray(files));
    assert.ok(files.length > 10, `expected 16+ CORE_FILES, got ${files.length}`);
    assert.ok(files.includes('shows.json'));
    assert.ok(files.includes('awards.json'));
    assert.ok(files.includes('opening-night-sent.json'));
  });
});

describe('findCoreFileWritesWithoutPush', () => {
  test('flags a git add of a CORE_FILES path with no push-core-data in the same job', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          git add --force data/awards.json
          git commit -m "data: update"
`);
    const violations = findCoreFileWritesWithoutPush(raw, CORE_FILES);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].coreFile, 'awards.json');
    assert.strictEqual(violations[0].job, 'reconcile');
  });

  test('does NOT flag when push-core-data runs in the same job', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          git add --force data/awards.json
          git commit -m "data: update"
      - name: Push core data
        uses: ./.github/actions/push-core-data
        with:
          token: \${{ secrets.REVIEW_TEXTS_TOKEN }}
`);
    const violations = findCoreFileWritesWithoutPush(raw, CORE_FILES);
    assert.deepStrictEqual(violations, []);
  });

  test('flags a multi-file git add line that includes a CORE_FILES path', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          git add data/other.json data/shows.json
          git commit -m "data: update"
`);
    const violations = findCoreFileWritesWithoutPush(raw, CORE_FILES);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].coreFile, 'shows.json');
  });

  test('does NOT flag a git add of a non-CORE_FILES path', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          git add data/audit/some-audit-file.json
          git commit -m "data: update"
`);
    const violations = findCoreFileWritesWithoutPush(raw, CORE_FILES);
    assert.deepStrictEqual(violations, []);
  });

  test('does NOT flag a commented-out git add (reference in a comment, not real code)', () => {
    const raw = synthetic(`
      - name: Commit
        run: |
          # A prior \`git add data/shows.json\` step was removed here.
          echo "no-op"
`);
    const violations = findCoreFileWritesWithoutPush(raw, CORE_FILES);
    assert.deepStrictEqual(violations, []);
  });

  test('push-core-data in a DIFFERENT job does not satisfy the same-job requirement', () => {
    const raw = `
jobs:
  writer:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/checkout-core-data
      - name: Commit
        run: |
          git add --force data/awards.json
          git commit -m "data: update"
  pusher:
    runs-on: ubuntu-latest
    steps:
      - name: Push core data
        uses: ./.github/actions/push-core-data
`;
    const violations = findCoreFileWritesWithoutPush(raw, CORE_FILES);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].job, 'writer');
  });
});
