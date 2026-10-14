// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the regex-detectors under
// test never read data/*.json; "data/shows.json" appears only as a string
// literal inside synthetic YAML fixtures.
/**
 * Regression tests for task #1474: the shared `^run:` parsing anchor used by
 * runLineMatches (rules b/c), findMissingGitIdentityCommits (rule d), and
 * findPipefailDeadExitCodeEcho (rule e) only matched lines where `run:` was
 * the first token after left-trim — it never matched the inline `- run: <cmd>`
 * list-item shorthand (real YAML syntax already used in this repo, e.g.
 * .github/workflows/overnight-collect.yml:48 `- run: npm ci`). Task #1461
 * fixed only rule (h)'s copy of this anchor; this file proves the other 4
 * copies now share the fix.
 *
 * Pattern: require() the real functions; never copy logic into tests
 * (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  runLineMatches,
  findMissingGitIdentityCommits,
  findPipefailDeadExitCodeEcho,
} = require('../../scripts/audit-workflow-hygiene.js');

describe('runLineMatches (rules b/c) — inline `- run:` shorthand', () => {
  test('matches `npx playwright install` written as `- run: <cmd>`', () => {
    const raw = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npx playwright install --with-deps
`;
    const hits = runLineMatches(raw, /npx playwright install/);
    assert.strictEqual(hits.length, 1);
  });

  test('matches a bare `git push` written as `- run: <cmd>`', () => {
    const raw = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: git push origin main
`;
    const hits = runLineMatches(raw, /\bgit push\b/);
    assert.strictEqual(hits.length, 1);
  });
});

describe('findMissingGitIdentityCommits (rule d) — inline `- run:` shorthand', () => {
  test('flags a `git commit` written as `- run: <cmd>` with no prior identity config', () => {
    const raw = `
jobs:
  commit-data:
    runs-on: ubuntu-latest
    steps:
      - run: git commit -m "data: update"
`;
    const violations = findMissingGitIdentityCommits(raw);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].job, 'commit-data');
  });

  test('an inline `- run:` git config satisfies a later block-style commit', () => {
    const raw = `
jobs:
  commit-data:
    runs-on: ubuntu-latest
    steps:
      - run: git config user.name "github-actions[bot]"
      - name: Commit
        run: |
          git commit -m "data: update"
`;
    const violations = findMissingGitIdentityCommits(raw);
    assert.deepStrictEqual(violations, []);
  });
});

describe('findPipefailDeadExitCodeEcho (rule e) — inline `- run: |` shorthand', () => {
  test('flags a bare `echo $?` inside a block whose opener is the `- run: |` list-item shorthand', () => {
    // The real gap: `- run: |` (dash + block-scalar opener on ONE line) was
    // invisible to the old `^run\s*:` anchor — extractRunBlocks never set
    // inRunBlock, so the entire indented body (including the violation)
    // was silently never scanned. `- run: echo $?` alone (no pipe/block
    // marker) is a single inline command and is correctly out of scope for
    // this rule by design (see extractRunBlocks' own doc comment) — the
    // shorthand only matters when it opens a block scalar.
    const raw = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          set -o pipefail
          cmd | tee /tmp/out.txt
          echo $?
`;
    const violations = findPipefailDeadExitCodeEcho(raw);
    assert.strictEqual(violations.length, 1);
  });

  test('does NOT flag a guarded `cmd || echo $?` inside a `- run: |` shorthand block', () => {
    const raw = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          set -o pipefail
          cmd | tee /tmp/out.txt || echo $?
`;
    const violations = findPipefailDeadExitCodeEcho(raw);
    assert.deepStrictEqual(violations, []);
  });
});
