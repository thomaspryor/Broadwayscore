import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'run-push-audits.sh');
const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const LINT_SCRIPT = join(LIB_DIR, '..', 'lint-write-routing.sh');

// --list mode selects without running (card #835) — fast + deterministic,
// doesn't pay for real audit runs against live repo state.
function listAudits(files) {
  const out = execFileSync('bash', [SCRIPT, '--list'], {
    input: files.join('\n'),
    encoding: 'utf8',
  });
  return out.trim().split('\n').filter(Boolean).sort();
}

test('empty file list selects no audits', () => {
  assert.deepEqual(listAudits([]), []);
});

test('unrelated file selects no audits', () => {
  assert.deepEqual(listAudits(['README.md']), []);
});

test('tests/unit/*.test.mjs selects tests-vs-derived-data + orphan-tests', () => {
  assert.deepEqual(
    listAudits(['tests/unit/push-ledger-store.test.mjs']),
    ['orphan-tests', 'tests-vs-derived-data']
  );
});

test('scripts/*.js selects unbounded-fetch + write-routing + help-flag-safety', () => {
  assert.deepEqual(
    listAudits(['scripts/recover-wsj-browser.js']),
    ['help-flag-safety', 'unbounded-fetch', 'write-routing']
  );
});

// The help-flag audit is the most frequent recurring cause of a red main here, so
// its selection is asserted on its own input too, not only via the scripts/*.js
// case above: the baseline file can change without any script changing.
test('help-flag baseline change alone selects help-flag-safety', () => {
  assert.deepEqual(
    listAudits(['scripts/.help-flag-safety-baseline.json']),
    ['help-flag-safety']
  );
});

test('tests/e2e/*.ts selects playwright-evaluate-click only', () => {
  assert.deepEqual(listAudits(['tests/e2e/foo.spec.ts']), ['playwright-evaluate-click']);
});

test('.github/workflows/*.yml selects unbounded-fetch', () => {
  assert.deepEqual(listAudits(['.github/workflows/test.yml']), [
    'orphan-tests',
    'tests-vs-derived-data',
    'unbounded-fetch',
  ]);
});

test('argv form (no stdin) matches piped-stdin form', () => {
  const out = execFileSync(
    'bash',
    [SCRIPT, '--list', 'scripts/recover-wsj-browser.js'],
    { encoding: 'utf8' }
  );
  assert.deepEqual(out.trim().split('\n').filter(Boolean).sort(), [
    'help-flag-safety',
    'unbounded-fetch',
    'write-routing',
  ]);
});

test('mixed file list unions all applicable audits', () => {
  assert.deepEqual(
    listAudits(['scripts/foo.js', 'tests/unit/bar.test.mjs', 'tests/e2e/baz.spec.ts']),
    ['help-flag-safety', 'orphan-tests', 'playwright-evaluate-click', 'tests-vs-derived-data', 'unbounded-fetch', 'write-routing']
  );
});

// --- write-routing diff-scoping (card #1826) ---------------------------------
//
// run-push-audits.sh runs in scripts/merge-worktree-to-main.sh's SHARED main
// checkout (used by 20+ concurrent worktree sessions), so its write-routing
// call must be scoped to the incoming diff, not the whole working tree —
// otherwise a stray/untracked file left by an unrelated session can block an
// unrelated push. Two things need covering: (1) that run-push-audits.sh is
// actually WIRED to pass --scope-stdin + the changed-file list through (cheap
// source assertion, no execution); (2) that lint-write-routing.sh's
// --scope-stdin logic itself does the right thing (live, in an isolated temp
// git repo — never the real shared checkout, which other sessions may be
// using concurrently).

test('run-push-audits.sh pipes CHANGED_FILES into lint-write-routing.sh --scope-stdin', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.match(
    src,
    /printf '%s\\n' "\$CHANGED_FILES" \| bash scripts\/lint-write-routing\.sh --scope-stdin all/,
    'write-routing call must forward $CHANGED_FILES via --scope-stdin, not scan the whole tree'
  );
});

// Exercises the actual --scope-stdin scoping logic in lint-write-routing.sh,
// isolated in a throwaway git repo — this never touches the real shared
// checkout, so it can't collide with other concurrent sessions the way a
// live repro against the real scripts/ directory would.
function makeScopeTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'lint-write-routing-scope-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('mkdir', ['scripts'], { cwd: dir });
  for (const name of [
    '.review-write-guard-exempt.txt',
    '.reviews-json-write-exempt.txt',
    '.shows-json-write-exempt.txt',
    '.commercial-json-write-exempt.txt',
    '.audience-buzz-json-write-exempt.txt',
  ]) {
    writeFileSync(join(dir, name), '# empty allowlist for test\n');
  }
  // Violates check_review_texts: writeFileSync(filePath, ...) + references
  // review-texts + no safeWriteReview import.
  writeFileSync(
    join(dir, 'scripts', 'stray.js'),
    "const fs = require('fs');\n" +
      "const REVIEW_TEXTS_DIR = 'data/review-texts';\n" +
      'function write(filePath, content) {\n' +
      '  fs.writeFileSync(filePath, content);\n' +
      '}\n'
  );
  writeFileSync(
    join(dir, 'scripts', 'target.js'),
    "console.log('clean script - no review-texts writes');\n"
  );
  return dir;
}

function runLint(dir, mode, scopeFiles) {
  const args = scopeFiles !== undefined ? ['--scope-stdin', mode] : [mode];
  try {
    const out = execFileSync('bash', [LINT_SCRIPT, ...args], {
      cwd: dir,
      input: scopeFiles !== undefined ? scopeFiles.join('\n') : undefined,
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('--scope-stdin: a stray violating file NOT in the diff does not block', () => {
  const dir = makeScopeTestRepo();
  try {
    const result = runLint(dir, 'review-texts', ['scripts/target.js']);
    assert.equal(result.code, 0, `expected pass, got:\n${result.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--scope-stdin: a violating file that IS in the diff still blocks (regression safety)', () => {
  const dir = makeScopeTestRepo();
  try {
    const result = runLint(dir, 'review-texts', ['scripts/stray.js']);
    assert.equal(result.code, 1, 'expected the in-scope violation to fail the audit');
    assert.match(result.out, /stray\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--scope-stdin: an allowlist-only diff falls back to a full scan (does not silently pass)', () => {
  const dir = makeScopeTestRepo();
  try {
    // Only the allowlist changed — none of scripts/*.js is in the diff. If
    // candidate_files() scoped naively, it would check zero files and pass
    // despite stray.js's real violation sitting unexamined in the tree.
    const result = runLint(dir, 'review-texts', ['.review-write-guard-exempt.txt']);
    assert.equal(result.code, 1, `expected fallback full-scan to still catch stray.js, got:\n${result.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no --scope-stdin (CI direct-call mode) still scans the whole tree', () => {
  const dir = makeScopeTestRepo();
  try {
    const result = runLint(dir, 'review-texts', undefined);
    assert.equal(result.code, 1, 'CI direct calls must keep scanning the full checkout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
