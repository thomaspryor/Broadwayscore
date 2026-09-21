// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — the regex-detectors under
// test never read data/*.json; "data/shows.json" appears only as a string
// literal inside synthetic YAML fixtures.
/**
 * Regression tests for task #1481: the shared `^run:` parsing anchor
 * (RUN_LINE_RE) used by rules (b)/(c), (d), (g), and (e) previously had to be
 * fixed in 5 near-identical copies (task #1461 fixed only rule (h)'s copy;
 * #1474 unified the other 4 in scripts/audit-workflow-hygiene.js; this file
 * extracts the shared predicates to scripts/lib/ per CLAUDE.md rule 15 and
 * proves the anchor gap stays closed with tests instead of eyeballing the
 * regex).
 *
 * Each rule below is exercised against the three shapes the old
 * `/^run\s*:\s*(.*?)\s*$/` anchor (missing the optional `-\s+` prefix) got
 * wrong or could get wrong:
 *   1. a `run:` indented under `steps:` in the ordinary block style (control —
 *      always worked, must keep working)
 *   2. the inline `- run: <cmd>` / `- run: |` list-item shorthand, including
 *      a trailing block-scalar opener (the actual gap — real syntax already
 *      used in this repo, e.g. .github/workflows/overnight-collect.yml:48)
 *   3. a line where `run:` appears NOT at the start of the trimmed line
 *      (embedded in a step name / quoted string value) — must NOT match,
 *      since RUN_LINE_RE answers "is this THE run: key", not "does the text
 *      run: appear anywhere on this line"
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
  findCoreFileWritesWithoutPush,
  findPipefailDeadExitCodeEcho,
  findBareAuditDirectoryGlobs,
} = require('./audit-workflow-hygiene-rules.js');

const CORE_FILES = ['shows.json', 'reviews.json'];

describe('runLineMatches (rules b/c)', () => {
  test('block-style `run:` indented under steps: matches', () => {
    const raw = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Install Playwright
        run: npx playwright install --with-deps
`;
    const hits = runLineMatches(raw, /npx playwright install/);
    assert.strictEqual(hits.length, 1);
  });

  test('inline `- run: <cmd>` list-item shorthand matches', () => {
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

  test('`run:` embedded mid-line in a quoted step name does NOT match', () => {
    const raw = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: "then run: npx playwright install --with-deps"
        run: echo "just a log line"
`;
    const hits = runLineMatches(raw, /npx playwright install/);
    assert.deepStrictEqual(hits, []);
  });
});

describe('findMissingGitIdentityCommits (rule d)', () => {
  test('block-style `run: |` with `git commit -m` indented under steps: is flagged', () => {
    const raw = `
jobs:
  commit-data:
    runs-on: ubuntu-latest
    steps:
      - name: Commit
        run: |
          git commit -m "data: update"
`;
    const violations = findMissingGitIdentityCommits(raw);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].job, 'commit-data');
  });

  test('inline `- run: git commit -m ...` shorthand is flagged', () => {
    const raw = `
jobs:
  commit-data:
    runs-on: ubuntu-latest
    steps:
      - run: git commit -m "data: update"
`;
    const violations = findMissingGitIdentityCommits(raw);
    assert.strictEqual(violations.length, 1);
  });

  test('a step name that merely mentions `run: git commit` does NOT count as the commit itself', () => {
    const raw = `
jobs:
  commit-data:
    runs-on: ubuntu-latest
    steps:
      - name: "Note: run: git commit happens later in this job"
        run: echo "just a log line"
`;
    const violations = findMissingGitIdentityCommits(raw);
    assert.deepStrictEqual(violations, []);
  });
});

describe('findCoreFileWritesWithoutPush (rule g)', () => {
  test('block-style `run: |` with `git add data/shows.json` indented under steps: is flagged', () => {
    const raw = `
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: Stage
        run: |
          git add data/shows.json
`;
    const violations = findCoreFileWritesWithoutPush(raw, CORE_FILES);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].coreFile, 'shows.json');
  });

  test('inline `- run: git add data/shows.json` shorthand is flagged', () => {
    const raw = `
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - run: git add data/shows.json
`;
    const violations = findCoreFileWritesWithoutPush(raw, CORE_FILES);
    assert.strictEqual(violations.length, 1);
  });

  test('`git add data/shows.json` inside a quoted step name (not the run: line itself) does NOT match', () => {
    const raw = `
jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - name: "run: git add data/shows.json happens in a later step"
        run: echo "just a log line"
`;
    const violations = findCoreFileWritesWithoutPush(raw, CORE_FILES);
    assert.deepStrictEqual(violations, []);
  });
});

describe('findPipefailDeadExitCodeEcho (rule e)', () => {
  test('block-style `run: |` indented under steps: with pipefail + bare echo $? is flagged', () => {
    const raw = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: |
          set -o pipefail
          cmd | tee /tmp/out.txt
          echo $?
`;
    const violations = findPipefailDeadExitCodeEcho(raw);
    assert.strictEqual(violations.length, 1);
  });

  test('inline `- run: |` list-item shorthand block-scalar opener is flagged (the actual #1474 gap)', () => {
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

  test('a quoted step name containing `run: |` and `echo $?` text is NOT treated as a run block', () => {
    const raw = `
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: "Docs: run: | then echo $? later"
        run: echo "just a log line, no pipefail here"
`;
    const violations = findPipefailDeadExitCodeEcho(raw);
    assert.deepStrictEqual(violations, []);
  });
});

describe('findBareAuditDirectoryGlobs (rule n, BRO-3990)', () => {
  test('bare `git add data/audit/` with no basename is flagged', () => {
    const raw = `
jobs:
  commit:
    runs-on: ubuntu-latest
    steps:
      - name: Commit
        run: |
          git add data/audit/
          git commit -m 'data: audit'
`;
    const violations = findBareAuditDirectoryGlobs(raw);
    assert.strictEqual(violations.length, 1);
    assert.deepStrictEqual(violations[0].paths, [{ path: 'data/audit/', kind: 'directory' }]);
  });

  test('bare `data/audit/<subdir>/` (no basename) is flagged the same way', () => {
    const raw = `
jobs:
  commit:
    runs-on: ubuntu-latest
    steps:
      - run: git add data/audit/pipeline-health/
`;
    const violations = findBareAuditDirectoryGlobs(raw);
    assert.strictEqual(violations.length, 1);
    assert.deepStrictEqual(violations[0].paths, [
      { path: 'data/audit/pipeline-health/', kind: 'directory' },
    ]);
  });

  test('git-add-existing.sh with a trailing bare directory arg is flagged (BRO-2722 residual shape)', () => {
    const raw = `
jobs:
  commit:
    runs-on: ubuntu-latest
    steps:
      - run: |
          bash scripts/lib/git-add-existing.sh data/audit/progress-watch-state.json data/audit/
`;
    const violations = findBareAuditDirectoryGlobs(raw);
    assert.strictEqual(violations.length, 1);
    assert.deepStrictEqual(violations[0].paths, [{ path: 'data/audit/', kind: 'directory' }]);
  });

  test('an extension glob and a wildcard-prefix basename are flagged as wildcard-basename (second-opinion finding: same blind spot as the bare-directory shape, via a different mechanism)', () => {
    const raw = `
jobs:
  commit:
    runs-on: ubuntu-latest
    steps:
      - run: git add data/audit/*.json data/audit/opening-night-latency-*.json
`;
    const violations = findBareAuditDirectoryGlobs(raw);
    assert.strictEqual(violations.length, 1);
    assert.deepStrictEqual(violations[0].paths, [
      { path: 'data/audit/*.json', kind: 'wildcard-basename' },
      { path: 'data/audit/opening-night-latency-*.json', kind: 'wildcard-basename' },
    ]);
  });

  test('an explicit concrete basename is NOT flagged', () => {
    const raw = `
jobs:
  commit:
    runs-on: ubuntu-latest
    steps:
      - run: git add data/audit/progress-watch-state.json
`;
    const violations = findBareAuditDirectoryGlobs(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('trailing shell operators (2>/dev/null || true) after the bare dir do not hide the match', () => {
    const raw = `
jobs:
  commit:
    runs-on: ubuntu-latest
    steps:
      - run: git add data/audit/ 2>/dev/null || true
`;
    const violations = findBareAuditDirectoryGlobs(raw);
    assert.strictEqual(violations.length, 1);
    assert.deepStrictEqual(violations[0].paths, [{ path: 'data/audit/', kind: 'directory' }]);
  });

  test('a quoted bare directory pathspec is still flagged with the quote stripped', () => {
    const raw = `
jobs:
  commit:
    runs-on: ubuntu-latest
    steps:
      - run: git add "data/audit/" || true
`;
    const violations = findBareAuditDirectoryGlobs(raw);
    assert.strictEqual(violations.length, 1);
    assert.deepStrictEqual(violations[0].paths, [{ path: 'data/audit/', kind: 'directory' }]);
  });

  test('KNOWN GAP: a bare directory arg on its OWN backslash-continuation line is not detected — matches rule (g)\'s documented continuation gap, no live occurrence at introduction (grep confirmed)', () => {
    const raw = `
jobs:
  commit:
    runs-on: ubuntu-latest
    steps:
      - run: |
          bash scripts/lib/git-add-existing.sh \\
            data/audit/progress-watch-state.json \\
            data/audit/
`;
    // findBareAuditDirectoryGlobs (like runLineMatches generally) scans one
    // physical line at a time; a pathspec on a continuation line by itself
    // never contains the `git add`/`git-add-existing.sh` trigger text, so it's
    // never a candidate line. Documented rather than fixed — same known-gap
    // posture as rule (g)'s own line-continuation note above.
    const violations = findBareAuditDirectoryGlobs(raw);
    assert.deepStrictEqual(violations, []);
  });

  test('a comment mentioning `git add data/audit/` is not flagged (not a real run: line)', () => {
    const raw = `
jobs:
  commit:
    runs-on: ubuntu-latest
    steps:
      - name: Commit
        run: |
          # historically this did: git add data/audit/
          git add data/audit/progress-watch-state.json
`;
    const violations = findBareAuditDirectoryGlobs(raw);
    assert.deepStrictEqual(violations, []);
  });
});
