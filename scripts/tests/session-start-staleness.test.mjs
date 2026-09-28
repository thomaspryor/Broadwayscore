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
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

// ── BRO-4229: cloud auto-sync (fast-forward only) ───────────────────────────
// Real scratch repos, real git. Every refusal must leave HEAD and the tree
// exactly as they were.

const {
  trySyncCodeCheckout,
  formatCodeCheckoutSyncMessage,
  registeredHookScripts,
} = require('../lib/code-checkout-staleness.js');

function withTrio(fn) {
  const trio = makeScratchRepoTrio();
  try { return fn(trio); } finally { fs.rmSync(trio.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}
function staleThenSync(cloneDir, env = {}) {
  const r = runCodeCheckoutStalenessCheck({ repoDir: cloneDir });
  return trySyncCodeCheckout({ repoDir: cloneDir, behind: r.behind, ahead: r.ahead, env });
}
function commitIn(dir, file, content, msg) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}

test('trySyncCodeCheckout: behind-only fast-forwards to origin/main and says how to undo', () => withTrio(({ seedDir, cloneDir }) => {
  const before = git(cloneDir, ['rev-parse', 'HEAD']);
  pushMoreCommits(seedDir, 3);
  const s = staleThenSync(cloneDir);
  assert.equal(s.synced, true, s.reason);
  assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), git(cloneDir, ['rev-parse', 'origin/main']));
  assert.equal(s.from, before);
  const msg = formatCodeCheckoutSyncMessage(s, cloneDir);
  assert.match(msg, /CODE CHECKOUT SYNCED: fast-forwarded .* by 3 commit\(s\)/);
  assert.match(msg, new RegExp(`reset --keep ${before.slice(0, 11)}`));
}));

test('trySyncCodeCheckout: diverged (local commits) is left alone — fast-forward only', () => withTrio(({ seedDir, cloneDir }) => {
  pushMoreCommits(seedDir, 1);
  commitIn(cloneDir, 'local.txt', 'local', 'local work');
  const head = git(cloneDir, ['rev-parse', 'HEAD']);
  const s = staleThenSync(cloneDir);
  assert.equal(s.synced, false);
  assert.match(s.reason, /fast-forward only/);
  assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), head);
}));

test('trySyncCodeCheckout: uncommitted tracked change refuses and the edit survives', () => withTrio(({ seedDir, cloneDir }) => {
  pushMoreCommits(seedDir, 1);
  fs.writeFileSync(path.join(cloneDir, 'a.txt'), 'edited');
  const head = git(cloneDir, ['rev-parse', 'HEAD']);
  const s = staleThenSync(cloneDir);
  assert.equal(s.synced, false);
  assert.match(s.reason, /uncommitted changes/);
  assert.equal(fs.readFileSync(path.join(cloneDir, 'a.txt'), 'utf8'), 'edited');
  assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), head);
}));

test('trySyncCodeCheckout: an untracked file the fast-forward would overwrite makes git refuse; nothing changes', () => withTrio(({ seedDir, cloneDir }) => {
  pushMoreCommits(seedDir, 1); // adds extra-0.txt upstream
  fs.writeFileSync(path.join(cloneDir, 'extra-0.txt'), 'mine');
  const head = git(cloneDir, ['rev-parse', 'HEAD']);
  const s = staleThenSync(cloneDir);
  assert.equal(s.synced, false);
  assert.match(s.reason, /fast-forward refused/);
  assert.equal(fs.readFileSync(path.join(cloneDir, 'extra-0.txt'), 'utf8'), 'mine');
  assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), head);
}));

test('trySyncCodeCheckout: an operation in progress (MERGE_HEAD) refuses', () => withTrio(({ seedDir, cloneDir }) => {
  pushMoreCommits(seedDir, 1);
  const head = git(cloneDir, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(cloneDir, '.git', 'MERGE_HEAD'), `${head}\n`);
  const s = staleThenSync(cloneDir);
  assert.equal(s.synced, false);
  assert.match(s.reason, /MERGE_HEAD in progress/);
  assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), head);
}));

test('trySyncCodeCheckout: refuses when origin/main deletes a hook script this session has registered', () => withTrio(({ seedDir, cloneDir }) => {
  const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash "$R/.claude/hooks/gone.sh"' }] }] } });
  commitIn(seedDir, '.claude/settings.json', settings, 'register gone.sh');
  commitIn(seedDir, '.claude/hooks/gone.sh', 'exit 0\n', 'add gone.sh');
  git(seedDir, ['push', '-q', 'origin', 'main']);
  git(cloneDir, ['pull', '-q', '--ff-only', 'origin', 'main']);
  git(seedDir, ['rm', '-q', '.claude/hooks/gone.sh']);
  git(seedDir, ['commit', '-q', '-m', 'retire gone.sh']);
  git(seedDir, ['push', '-q', 'origin', 'main']);
  const head = git(cloneDir, ['rev-parse', 'HEAD']);
  const s = staleThenSync(cloneDir);
  assert.equal(s.synced, false);
  assert.match(s.reason, /removes registered hook script\(s\): \.claude\/hooks\/gone\.sh/);
  assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), head);
}));

test('trySyncCodeCheckout: CODE_SYNC_DISABLED=1 is a kill switch', () => withTrio(({ seedDir, cloneDir }) => {
  pushMoreCommits(seedDir, 1);
  const s = staleThenSync(cloneDir, { CODE_SYNC_DISABLED: '1' });
  assert.equal(s.synced, false);
  assert.match(s.reason, /disabled/);
}));

test('trySyncCodeCheckout: a changed CLAUDE.md / settings.json is called out for re-read / new session', () => withTrio(({ seedDir, cloneDir }) => {
  commitIn(seedDir, 'CLAUDE.md', 'new rules', 'rules');
  commitIn(seedDir, '.claude/settings.json', '{}', 'settings');
  git(seedDir, ['push', '-q', 'origin', 'main']);
  const s = staleThenSync(cloneDir);
  assert.equal(s.synced, true, s.reason);
  assert.deepEqual(s.changedWatched, ['CLAUDE.md', '.claude/settings.json']);
  const msg = formatCodeCheckoutSyncMessage(s, cloneDir);
  assert.match(msg, /CLAUDE\.md\. Re-read them now/);
  assert.match(msg, /new hook wiring only takes effect in a new session/);
}));

test('trySyncCodeCheckout: works from a shallow clone (cloud clones are shallow)', () => withTrio(({ root, originDir, seedDir }) => {
  pushMoreCommits(seedDir, 4);
  const shallowDir = path.join(root, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${originDir}`, shallowDir]);
  assert.equal(git(shallowDir, ['rev-parse', '--is-shallow-repository']), 'true');
  commitIn(seedDir, 'late-0.txt', '0', 'late 0');
  commitIn(seedDir, 'late-1.txt', '1', 'late 1');
  git(seedDir, ['push', '-q', 'origin', 'main']);
  const s = staleThenSync(shallowDir);
  assert.equal(s.synced, true, s.reason);
  assert.equal(git(shallowDir, ['rev-parse', 'HEAD']), git(shallowDir, ['rev-parse', 'origin/main']));
}));

test('registeredHookScripts: pulls every .claude/hooks/*.sh out of settings.json text', () => {
  const real = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8');
  const hooks = registeredHookScripts(real);
  assert.ok(hooks.includes('.claude/hooks/verify-edits.sh'));
  assert.ok(hooks.includes('.claude/hooks/session-start.sh'));
  for (const h of hooks) assert.ok(fs.existsSync(path.join(REPO_ROOT, h)), `${h} registered but missing`);
});

test('session-start.sh: end-to-end in a cloud-like env, a resumed stale checkout is fast-forwarded', () => withTrio(({ seedDir, cloneDir }) => {
  // The real hook + real lib, committed into the scratch repo so the hook's
  // `-f $CODE_DIR/scripts/lib/...` gate finds it at CLAUDE_PROJECT_DIR.
  commitIn(seedDir, 'scripts/lib/code-checkout-staleness.js',
    fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'code-checkout-staleness.js'), 'utf8'), 'lib');
  git(seedDir, ['push', '-q', 'origin', 'main']);
  git(cloneDir, ['pull', '-q', '--ff-only', 'origin', 'main']);
  pushMoreCommits(seedDir, 2);
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4229-home-'));
  try {
    const out = execFileSync('bash', [path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh')], {
      cwd: cloneDir, input: '{"source":"resume"}', encoding: 'utf8', timeout: 120000,
      env: { ...process.env, HOME: fakeHome, CLAUDE_CODE_REMOTE: 'true', CLAUDE_PROJECT_DIR: cloneDir, CODE_SYNC_DISABLED: '' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    assert.match(out, /CODE CHECKOUT SYNCED: fast-forwarded .* by 2 commit\(s\)/);
    assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), git(cloneDir, ['rev-parse', 'origin/main']));
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}));

test('session-start.sh: without CLAUDE_CODE_REMOTE (Mac-like) it only warns and never moves HEAD', () => withTrio(({ seedDir, cloneDir }) => {
  commitIn(seedDir, 'scripts/lib/code-checkout-staleness.js',
    fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'code-checkout-staleness.js'), 'utf8'), 'lib');
  git(seedDir, ['push', '-q', 'origin', 'main']);
  git(cloneDir, ['pull', '-q', '--ff-only', 'origin', 'main']);
  pushMoreCommits(seedDir, 2);
  const head = git(cloneDir, ['rev-parse', 'HEAD']);
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4229-home-'));
  try {
    const env = { ...process.env, HOME: fakeHome };
    delete env.CLAUDE_CODE_REMOTE;
    delete env.CLAUDE_PROJECT_DIR;
    const out = execFileSync('bash', [path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh')], {
      cwd: cloneDir, input: '{"source":"resume"}', encoding: 'utf8', timeout: 120000, env, stdio: ['pipe', 'pipe', 'ignore'],
    });
    assert.match(out, /STALE CODE CHECKOUT/);
    assert.doesNotMatch(out, /SYNCED/);
    assert.equal(git(cloneDir, ['rev-parse', 'HEAD']), head);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}));

// BRO-4234's printed owner banner was replaced by the installed global
// instructions (BRO-4237): see scripts/tests/global-instructions.test.mjs.
