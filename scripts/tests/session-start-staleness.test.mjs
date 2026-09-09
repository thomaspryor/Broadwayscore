// BRO-2663: nothing warned when the ~/Broadwayscore CODE checkout itself was
// behind origin/main — a crown session read a stale checkout (18 commits
// behind) and nearly concluded a landed commit's tests had been reverted,
// when they hadn't. Real functions via require() — never copies (CLAUDE.md
// §15). See scripts/lib/code-checkout-staleness.js for the full incident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  formatCodeCheckoutStaleMessage,
  runCodeCheckoutStalenessCheck,
} = require('../lib/code-checkout-staleness.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── formatCodeCheckoutStaleMessage: pure ────────────────────────────────────

test('formatCodeCheckoutStaleMessage: behind-only carries the ff-only remedy and the data/audit telemetry note', () => {
  const msg = formatCodeCheckoutStaleMessage({ behind: 18, ahead: 0 }, '/Users/tompryor/Broadwayscore');
  assert.match(msg, /STALE CODE CHECKOUT/);
  assert.match(msg, /18 commit\(s\) behind/);
  assert.match(msg, /git merge --ff-only origin\/main/);
  assert.match(msg, /data\/audit/, 'must warn about the telemetry that blocks the ff-only merge');
  assert.match(msg, /commit\s+it first/i);
  assert.match(msg, /Do NOT `git stash`/, 'must steer away from the forbidden remedy on the shared checkout');
});

test('formatCodeCheckoutStaleMessage: diverged (behind AND ahead) does not claim ff-only works', () => {
  const msg = formatCodeCheckoutStaleMessage({ behind: 3, ahead: 2 }, '/Users/tompryor/Broadwayscore');
  assert.match(msg, /DIVERGED/);
  assert.doesNotMatch(msg, /--ff-only/, 'ff-only cannot succeed once local commits exist, must not be suggested');
});

test('formatCodeCheckoutStaleMessage: current checkout (0 behind) produces no message', () => {
  assert.equal(formatCodeCheckoutStaleMessage({ behind: 0, ahead: 0 }, '/repo'), null);
  assert.equal(formatCodeCheckoutStaleMessage({ behind: 0, ahead: 4 }, '/repo'), null, 'ahead-only (normal worktree state) is not a staleness warning');
});

// ── runCodeCheckoutStalenessCheck: real git repos ───────────────────────────

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeScratchRepoTrio() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2663-staleness-'));
  const originDir = path.join(root, 'origin.git');
  const seedDir = path.join(root, 'seed');
  const cloneDir = path.join(root, 'clone');

  fs.mkdirSync(originDir);
  git(originDir, ['init', '--bare', '-q', '-b', 'main']);

  fs.mkdirSync(seedDir);
  git(seedDir, ['init', '-q', '-b', 'main']);
  git(seedDir, ['config', 'user.email', 'test@example.com']);
  git(seedDir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(seedDir, 'a.txt'), '1');
  git(seedDir, ['add', '.']);
  git(seedDir, ['commit', '-q', '-m', 'c1']);
  git(seedDir, ['remote', 'add', 'origin', originDir]);
  git(seedDir, ['push', '-q', 'origin', 'main']);

  execFileSync('git', ['clone', '-q', originDir, cloneDir], { encoding: 'utf8' });
  git(cloneDir, ['config', 'user.email', 'test@example.com']);
  git(cloneDir, ['config', 'user.name', 'Test']);

  return { root, originDir, seedDir, cloneDir };
}

function pushMoreCommits(seedDir, count) {
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(seedDir, `extra-${i}.txt`), String(i));
    git(seedDir, ['add', '.']);
    git(seedDir, ['commit', '-q', '-m', `extra ${i}`]);
  }
  git(seedDir, ['push', '-q', 'origin', 'main']);
}

test('runCodeCheckoutStalenessCheck: reports a non-zero behind count when HEAD is an ancestor of origin/main', () => {
  const { root, seedDir, cloneDir } = makeScratchRepoTrio();
  try {
    pushMoreCommits(seedDir, 2);

    const { behind, ahead, message } = runCodeCheckoutStalenessCheck({ repoDir: cloneDir });

    assert.equal(ahead, 0);
    assert.equal(behind, 2, 'clone HEAD is exactly 2 commits behind the pushed origin/main');
    assert.match(message, /STALE CODE CHECKOUT/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodeCheckoutStalenessCheck: goes to zero-behind once HEAD is brought current (proves the prior assertion can fail)', () => {
  // Same scenario as the previous test, but this time we apply the hook's
  // own remedy before asserting. If the behind-count logic were broken (e.g.
  // always returning a hardcoded non-zero, or comparing the wrong refs),
  // this assertion — not the previous one — is what would go red.
  const { root, seedDir, cloneDir } = makeScratchRepoTrio();
  try {
    pushMoreCommits(seedDir, 2);
    runCodeCheckoutStalenessCheck({ repoDir: cloneDir }); // fetches origin/main into the clone's tracking ref

    git(cloneDir, ['merge', '--ff-only', 'origin/main']);

    const { behind, ahead, message } = runCodeCheckoutStalenessCheck({ repoDir: cloneDir });
    assert.equal(behind, 0, 'HEAD now IS origin/main — must read as current, not stale');
    assert.equal(ahead, 0);
    assert.equal(message, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runCodeCheckoutStalenessCheck: diverged when the clone has local commits AND origin has moved on', () => {
  const { root, seedDir, cloneDir } = makeScratchRepoTrio();
  try {
    pushMoreCommits(seedDir, 1);
    fs.writeFileSync(path.join(cloneDir, 'local.txt'), 'local');
    git(cloneDir, ['add', '.']);
    git(cloneDir, ['commit', '-q', '-m', 'local commit']);

    const { behind, ahead, message } = runCodeCheckoutStalenessCheck({ repoDir: cloneDir });
    assert.equal(behind, 1);
    assert.equal(ahead, 1);
    assert.match(message, /DIVERGED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── session-start.sh wiring ──────────────────────────────────────────────

test('session-start.sh (repo copy) is wired to code-checkout-staleness.js and skips inside a worktree', () => {
  const hookSrc = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh'), 'utf8');
  assert.match(hookSrc, /scripts\/lib\/code-checkout-staleness\.js/, 'hook must require the lib, not just leave it unused');
  assert.match(hookSrc, /runCodeCheckoutStalenessCheck/);
  assert.match(hookSrc, /\.claude\/worktrees\//, 'must gate out worktree sessions — a worktree branch is ahead of origin/main by definition');
});

test('session-start.sh (global ~/.claude copy) carries the same wiring — local sessions self-skip the repo copy', () => {
  const globalPath = path.join(os.homedir(), '.claude', 'hooks', 'session-start.sh');
  if (!fs.existsSync(globalPath)) return; // cloud sandboxes have no ~/.claude
  const hookSrc = fs.readFileSync(globalPath, 'utf8');
  assert.match(hookSrc, /scripts\/lib\/code-checkout-staleness\.js/);
  assert.match(hookSrc, /runCodeCheckoutStalenessCheck/);
  assert.match(hookSrc, /\.claude\/worktrees\//);
});
