// tests/unit/pre-push-visual-gate-scope.test.mjs — task #879.
//
// pre-push-visual-gate.sh decides whether a push touched UI files by diffing
// origin/main...$DIFF_REF. On a shared local main checkout (~20 parallel
// worktree sessions, only one of which can have `main` checked out at a
// time), that diff includes every OTHER session's already-merged-but-
// unpushed commits too — a session pushing a pure backend/data change can
// get told "UI files changed, run /visual-qa" because another session's
// unrelated .tsx/.css commit is sitting on shared local main. Same root
// cause as task #828 (review-gate.mjs), fixed there via own-merge scoping
// (ownMergeParent / diffRangeArgs). This test asserts
// scripts/lib/review-gate.mjs's scopedChangedFiles — the function the hook
// now calls via `--query=changed-files` — applies that same scoping to an
// arbitrary UI-file pattern, not just review-gate's own GATED_PATH_RE.

import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveBase, scopedChangedFiles } from '../../scripts/lib/review-gate.mjs';

// Same UI_PATTERN pre-push-visual-gate.sh uses.
const UI_PATTERN = /^(src\/.*\.(tsx|jsx|css|scss|module\.css)$|tailwind\.config\.|postcss\.config\.|src\/app\/.*\.(tsx|jsx|ts|js)$)/;

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'pre-push-visual-gate-scope-test-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'base.ts'), 'export const x = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return repo;
}

function commitFile(repo, relPath, contents, msg) {
  const dir = join(repo, relPath.split('/').slice(0, -1).join('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, relPath), contents);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', msg);
}

// Two sessions' branches land on the same shared local main: sessionA
// merges a UI (.tsx) change first, then — before anything is pushed to
// origin — sessionB merges its own backend-only (.js) branch on top.
// sessionB is the one about to push and never touched a UI file.
function makeSharedMainWithTwoBranches() {
  const repo = makeRepo();
  git(repo, 'checkout', '-q', '-b', 'sessionA-branch');
  commitFile(repo, 'src/components/Widget.tsx', 'export const Widget = () => null;\n', 'sessionA: UI change');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge sessionA-branch', 'sessionA-branch');

  git(repo, 'checkout', '-q', '-b', 'sessionB-branch');
  commitFile(repo, 'scripts/backend.js', 'module.exports = () => 1;\n', 'sessionB: backend-only change');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge sessionB-branch', 'sessionB-branch');
  return repo;
}

test('ACCEPTANCE: UI-files-changed diff for a push includes ONLY the pushing branch\'s commits', (t) => {
  const repo = makeSharedMainWithTwoBranches();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const base = resolveBase(repo);
  const { files } = scopedChangedFiles(repo, base, 'HEAD', UI_PATTERN);
  assert.deepEqual(files, [], 'sessionB touched no UI files — must not see sessionA\'s Widget.tsx');
});

test('without own-merge scoping the naive diff would have wrongly flagged UI files (sanity check on fixture)', (t) => {
  const repo = makeSharedMainWithTwoBranches();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const base = resolveBase(repo);
  const naive = execFileSync('git', ['-C', repo, 'diff', '--name-only', `${base}...HEAD`], { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const naiveUiHit = naive.some(p => UI_PATTERN.test(p));
  assert.ok(naiveUiHit, `fixture should show a false-positive UI hit pre-fix, got ${JSON.stringify(naive)}`);
});

test('a push that genuinely touches a UI file is still detected (fix does not disable the gate)', (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'checkout', '-q', '-b', 'other-session-branch');
  commitFile(repo, 'scripts/other.js', 'module.exports = () => 2;\n', 'other session, unrelated');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge other-session-branch', 'other-session-branch');

  git(repo, 'checkout', '-q', '-b', 'my-branch');
  commitFile(repo, 'src/components/MyCard.tsx', 'export const MyCard = () => null;\n', 'my own UI change');
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge my-branch', 'my-branch');

  const base = resolveBase(repo);
  const { files } = scopedChangedFiles(repo, base, 'HEAD', UI_PATTERN);
  assert.deepEqual(files, ['src/components/MyCard.tsx']);
});

test('REGRESSION: scoping survives a trailing non-merge commit on top of the merge (e.g. an auto-commit)', (t) => {
  const repo = makeSharedMainWithTwoBranches();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  commitFile(repo, 'scripts/followup.js', 'module.exports = () => 3;\n', 'small trailing commit after the merge');

  const base = resolveBase(repo);
  const { files } = scopedChangedFiles(repo, base, 'HEAD', UI_PATTERN);
  assert.deepEqual(files, [], 'trailing non-merge commit must not resurrect sessionA\'s UI file');
});
