// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the detector under test
// never reads data/*.json; it only parses synthetic YAML strings.
/**
 * Unit tests for findShortRebuildTimeoutSteps (rule (y), BRO-5426): a step
 * that runs scripts/rebuild-all-reviews.js with a step timeout too small for
 * the rebuild. The poller's fast_path step sat at 5 min while one rebuild took
 * 3.5-5 min, so about half its runs failed and paged the owner.
 *
 * Pattern: require() the real function; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findShortRebuildTimeoutSteps } = require('../../scripts/audit-workflow-hygiene.js');

const synthetic = (body) => `
jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${body}
`;

describe('findShortRebuildTimeoutSteps', () => {
  test('flags a single-rebuild step at 5 minutes (the BRO-5426 bug)', () => {
    const hits = findShortRebuildTimeoutSteps(synthetic(`
      - name: Rebuild
        run: node scripts/rebuild-all-reviews.js 2>&1 | tail -5
        timeout-minutes: 5
`));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].requiredMin, 10);
  });

  test('a step that retries the rebuild needs 15, so 10 is flagged', () => {
    const hits = findShortRebuildTimeoutSteps(synthetic(`
      - name: Rebuild with retry
        run: |
          if node scripts/rebuild-all-reviews.js; then
            echo ok
          else
            node scripts/rebuild-all-reviews.js
          fi
        timeout-minutes: 10
`));
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].calls, 2);
    assert.strictEqual(hits[0].requiredMin, 15);
  });

  test('passes at the required floor', () => {
    const hits = findShortRebuildTimeoutSteps(synthetic(`
      - name: Rebuild
        run: node scripts/rebuild-all-reviews.js
        timeout-minutes: 10
`));
    assert.deepStrictEqual(hits, []);
  });

  test('ignores a step with no explicit timeout (job timeout bounds it)', () => {
    const hits = findShortRebuildTimeoutSteps(synthetic(`
      - name: Rebuild
        run: node scripts/rebuild-all-reviews.js
`));
    assert.deepStrictEqual(hits, []);
  });

  test('ignores comments and alert text that only mention the script', () => {
    const hits = findShortRebuildTimeoutSteps(synthetic(`
      - name: Alert
        # node scripts/rebuild-all-reviews.js is slow
        run: echo "rebuild-all-reviews.js stalled"
        timeout-minutes: 2
`));
    assert.deepStrictEqual(hits, []);
  });

  test('does not read the next job timeout into this step', () => {
    const raw = synthetic(`
      - name: Rebuild
        run: node scripts/rebuild-all-reviews.js
  other:
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - run: echo hi
`);
    assert.deepStrictEqual(findShortRebuildTimeoutSteps(raw), []);
  });

  test('reads a step timeout with a trailing comment or quotes', () => {
    const hits = findShortRebuildTimeoutSteps(synthetic(`
      - name: Rebuild
        run: node scripts/rebuild-all-reviews.js
        timeout-minutes: '5'  # too tight
`));
    assert.strictEqual(hits.length, 1);
  });

  test('ignores a with: input named timeout-minutes', () => {
    const hits = findShortRebuildTimeoutSteps(synthetic(`
      - name: Rebuild
        uses: some/action@v1
        with:
          timeout-minutes: 5
        run: node scripts/rebuild-all-reviews.js
        timeout-minutes: 30
`));
    assert.deepStrictEqual(hits, []);
  });
});
