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
import { execFileSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';

const require = createRequire(import.meta.url);
const {
  formatCodeCheckoutStaleMessage,
  runCodeCheckoutStalenessCheck,
  UNPUSHED_BACKLOG_THRESHOLD,
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

// ── BRO-3006: local main AHEAD of origin/main (unpushed backlog) ─────────

test('formatCodeCheckoutStaleMessage: local main ahead past the threshold warns UNPUSHED BACKLOG with the count', () => {
  const msg = formatCodeCheckoutStaleMessage({ behind: 0, ahead: 86, branch: 'main' }, '/repo');
  assert.match(msg, /UNPUSHED BACKLOG/);
  assert.match(msg, /86 commit\(s\) ahead of origin\/main/);
  assert.match(msg, /git log --oneline origin\/main\.\.main/);
});

test('formatCodeCheckoutStaleMessage: no backlog warning at or under the threshold, or off main', () => {
  assert.equal(formatCodeCheckoutStaleMessage({ behind: 0, ahead: UNPUSHED_BACKLOG_THRESHOLD, branch: 'main' }, '/repo'), null);
  assert.equal(formatCodeCheckoutStaleMessage({ behind: 0, ahead: 40, branch: 'claude/feature-x' }, '/repo'), null,
    'a feature or harness branch is ahead by design');
  assert.equal(formatCodeCheckoutStaleMessage({ behind: 0, ahead: 40 }, '/repo'), null, 'unknown branch stays silent');
});

function commitLocally(cloneDir, count, tag = 'a') {
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(cloneDir, `local-${tag}-${i}.txt`), String(i));
    git(cloneDir, ['add', '.']);
    git(cloneDir, ['commit', '-q', '-m', `local ${i}`]);
  }
}

test('runCodeCheckoutStalenessCheck: real repo, local main 6 ahead of origin/main warns UNPUSHED BACKLOG', () => {
  const { root, cloneDir } = makeScratchRepoTrio();
  try {
    commitLocally(cloneDir, UNPUSHED_BACKLOG_THRESHOLD + 1);
    const { behind, ahead, branch, message } = runCodeCheckoutStalenessCheck({ repoDir: cloneDir });
    assert.equal(behind, 0);
    assert.equal(ahead, 6);
    assert.equal(branch, 'main');
    assert.match(message, /UNPUSHED BACKLOG: local main .* is 6 commit\(s\) ahead/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('runCodeCheckoutStalenessCheck: real repo, 5 ahead / even / behind print no backlog warning', () => {
  const { root, seedDir, cloneDir } = makeScratchRepoTrio();
  try {
    assert.equal(runCodeCheckoutStalenessCheck({ repoDir: cloneDir }).message, null, 'even with origin/main');
    pushMoreCommits(seedDir, 1);
    const behindOnly = runCodeCheckoutStalenessCheck({ repoDir: cloneDir });
    assert.doesNotMatch(behindOnly.message, /UNPUSHED BACKLOG/);
    git(cloneDir, ['merge', '--ff-only', '-q', 'origin/main']);
    commitLocally(cloneDir, UNPUSHED_BACKLOG_THRESHOLD);
    const atThreshold = runCodeCheckoutStalenessCheck({ repoDir: cloneDir });
    assert.equal(atThreshold.ahead, 5);
    assert.equal(atThreshold.message, null);
    commitLocally(cloneDir, 1, 'b');
    git(cloneDir, ['checkout', '-q', '-b', 'feature']);
    assert.equal(runCodeCheckoutStalenessCheck({ repoDir: cloneDir }).message, null, 'same commits on a feature branch');
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
    const out = execFileSyncStdinFile('bash', [path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh')], {
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
    const out = execFileSyncStdinFile('bash', [path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh')], {
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

// ── BRO-5359: a slow fetch used to fail silently, leaving cloud hooks a day old ─────────────────────

test('fetch timeout: cloud gets the long budget, the default stays 5s, and a failed fetch is reported (not swallowed)', () => {
  const { CLOUD_FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS, fetchOriginMain, formatFetchFailedMessage } = require('../lib/code-checkout-staleness.js');
  assert.equal(FETCH_TIMEOUT_MS, 5000);
  assert.ok(CLOUD_FETCH_TIMEOUT_MS >= 30000, 'a cold cloud fetch of this repo needs far more than 5s');
  const seen = [];
  const slow = (cmd, args, opts) => { seen.push(opts.timeout); if (opts.timeout < 30000) { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; } return ''; };
  assert.equal(fetchOriginMain('/x', slow), false, 'the default 5s budget fails against a slow remote');
  assert.equal(fetchOriginMain('/x', slow, CLOUD_FETCH_TIMEOUT_MS), true, 'the cloud budget succeeds');
  assert.deepEqual(seen, [5000, CLOUD_FETCH_TIMEOUT_MS]);

  const r = runCodeCheckoutStalenessCheck({ repoDir: '/x', execFn: (cmd, args) => { if (args.includes('fetch')) throw new Error('timeout'); return args.includes('rev-list') ? '0' : ''; } });
  assert.equal(r.fetched, false, 'the check says the fetch failed');
  const msg = formatFetchFailedMessage('/home/user/broadwayscore', 'Tue Oct 13 13:18:36 2026');
  assert.match(msg, /HOOKS MAY BE STALE/);
  assert.match(msg, /timed out after \d+s, or a network\/auth error/);
  assert.match(msg, /Tue Oct 13 13:18:36 2026/);
  assert.match(msg, /merge --ff-only origin\/main/);
});

test('session-start.sh passes the cloud budget and prints the stale-hooks warning when the fetch fails', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh'), 'utf8');
  assert.match(src, /fetchTimeoutMs: cloud \? lib\.CLOUD_FETCH_TIMEOUT_MS : undefined/);
  assert.match(src, /r\.fetched === false/);
  assert.match(src, /formatFetchFailedMessage/);
});

// ── BRO-5359: background catch-up for a checkout too far behind to fetch within the startup budget ─────

function makeStaleClone() {
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-sync-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const sh = (cwd, c) => { const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${c}\n${r.stderr}`); return r.stdout.trim(); };
  const noMaint = 'git config gc.auto 0 && git config gc.autoDetach false && git config maintenance.auto false';
  const publish = ['git', 'push', '-q', 'origin', 'main'].join(' ');
  sh(dir, `git init -q --bare -b main origin.git && (cd origin.git && ${noMaint} && git config receive.autogc false) && git clone -q origin.git seed 2>/dev/null; cd seed && ${noMaint} && git checkout -q -B main && mkdir -p data scripts && echo one > data/core.json && echo code1 > scripts/a.js && git add -A && git commit -q -m one && ${publish} && cd .. && git clone -q origin.git stale && cd stale && ${noMaint}`);
  sh(path.join(dir, 'seed'), `echo code2 > scripts/a.js && echo two > data/core.json && git commit -qam two && echo code3 > scripts/a.js && git commit -qam three && ${publish}`);
  return { dir, env, stale: path.join(dir, 'stale'), sh, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}

test('backgroundCatchUp: a modified tracked data/ file is preserved byte for byte across the fast-forward', () => {
  const { backgroundCatchUp } = require('../lib/code-checkout-staleness.js');
  const t = makeStaleClone();
  try {
    const mine = 'my local cloud copy, not what the repo has\n';
    fs.writeFileSync(path.join(t.stale, 'data', 'core.json'), mine); // the edit that blocks a plain `merge --ff-only`
    const head = t.sh(t.stale, 'git rev-parse HEAD');
    const r = backgroundCatchUp({ repoDir: t.stale, expectHead: head, attempts: 1 });
    assert.equal(r.synced, true, JSON.stringify(r));
    assert.equal(r.preserved, 1);
    assert.equal(fs.readFileSync(path.join(t.stale, 'scripts', 'a.js'), 'utf8').trim(), 'code3', 'the code is current');
    assert.equal(fs.readFileSync(path.join(t.stale, 'data', 'core.json'), 'utf8'), mine, 'the data file has exactly the bytes it had');
    assert.equal(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('code-sync-backup-')).length, 0, 'the temporary backup was cleaned up');
  } finally { t.cleanup(); }
});

test('backgroundCatchUp: never touches real work (tracked edit outside data/, local commits, moved HEAD, kill switch)', () => {
  const { backgroundCatchUp } = require('../lib/code-checkout-staleness.js');
  const t = makeStaleClone();
  try {
    const head = t.sh(t.stale, 'git rev-parse HEAD');
    // 1. a tracked edit outside data/ is real work: refused, and the edit is untouched
    fs.writeFileSync(path.join(t.stale, 'scripts', 'a.js'), 'my edit\n');
    let r = backgroundCatchUp({ repoDir: t.stale, expectHead: head, attempts: 1 });
    assert.equal(r.synced, false);
    assert.match(r.reason, /uncommitted changes outside data\//);
    assert.equal(fs.readFileSync(path.join(t.stale, 'scripts', 'a.js'), 'utf8'), 'my edit\n');
    t.sh(t.stale, 'git checkout -q -- scripts');
    // 2. the kill switch wins before anything (even the fetch) happens
    const calls = [];
    r = backgroundCatchUp({ repoDir: t.stale, execFn: (...a) => { calls.push(a); return ''; }, env: { CODE_SYNC_DISABLED: '1' } });
    assert.equal(r.synced, false);
    assert.match(r.reason, /CODE_SYNC_DISABLED/);
    assert.equal(calls.length, 0, 'no git command ran');
    // 3. HEAD moved since startup
    fs.writeFileSync(path.join(t.stale, 'scripts', 'b.js'), 'x\n');
    t.sh(t.stale, 'git add -A && git commit -q -m mine');
    r = backgroundCatchUp({ repoDir: t.stale, expectHead: head, attempts: 1 });
    assert.match(r.reason, /HEAD moved since startup/);
    // 4. even without a pinned HEAD, a local commit is "ahead" and is refused
    r = backgroundCatchUp({ repoDir: t.stale, attempts: 1 });
    assert.equal(r.synced, false);
    assert.match(r.reason, /local commit\(s\) not on origin\/main/);
  } finally { t.cleanup(); }
});

test('backgroundCatchUp: gives up quietly when the remote never answers, and does nothing when already current', () => {
  const { backgroundCatchUp } = require('../lib/code-checkout-staleness.js');
  const t = makeStaleClone();
  try {
    const sleeps = [];
    t.sh(t.dir, 'mv origin.git origin.gone');
    let r = backgroundCatchUp({ repoDir: t.stale, attempts: 3, sleepFn: (ms) => sleeps.push(ms), pauseMs: 7 });
    assert.equal(r.synced, false);
    assert.match(r.reason, /could not be fetched after 3 attempt/);
    assert.deepEqual(sleeps, [7, 7], 'pauses between attempts, not after the last');
    t.sh(t.dir, 'mv origin.gone origin.git');
    r = backgroundCatchUp({ repoDir: t.stale, attempts: 1 });
    assert.equal(r.synced, true);
    r = backgroundCatchUp({ repoDir: t.stale, attempts: 1 });
    assert.equal(r.reason, 'already current');
  } finally { t.cleanup(); }
});

test('--bg-sync process: really runs detached-style, logs the outcome, and only one job runs at a time', () => {
  const { spawnSync } = require('child_process');
  const lib = path.join(REPO_ROOT, 'scripts', 'lib', 'code-checkout-staleness.js');
  const t = makeStaleClone();
  const log = path.join(t.dir, 'bg.log');
  const lock = path.join(t.dir, 'bg.lock');
  const run = () => spawnSync(process.execPath, [lib, '--bg-sync', t.stale, t.sh(t.stale, 'git rev-parse HEAD')], { encoding: 'utf8', env: { ...t.env, CODE_CHECKOUT_BG_LOG: log, CODE_CHECKOUT_BG_LOCK: lock } });
  try {
    // a fresh lock held by another job: exit without touching anything
    fs.mkdirSync(lock);
    assert.equal(run().status, 0);
    assert.match(fs.readFileSync(log, 'utf8'), /another catch-up is already running/);
    assert.equal(fs.readFileSync(path.join(t.stale, 'scripts', 'a.js'), 'utf8').trim(), 'code1', 'not synced while locked');
    // a stale lock (40+ minutes old) is taken over
    const old = new Date(Date.now() - 50 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.equal(run().status, 0);
    assert.match(fs.readFileSync(log, 'utf8'), /synced \w+ -> \w+ \(2 commits\)/);
    assert.equal(fs.readFileSync(path.join(t.stale, 'scripts', 'a.js'), 'utf8').trim(), 'code3');
    assert.equal(fs.existsSync(lock), false, 'the lock is released');
  } finally { t.cleanup(); }
});

test('startBackgroundSync starts a detached node process for --bg-sync and reports its pid; the failure message mentions it', () => {
  const { startBackgroundSync, formatFetchFailedMessage } = require('../lib/code-checkout-staleness.js');
  const calls = [];
  const pid = startBackgroundSync('/home/user/x', { expectHead: 'abc123', spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { pid: 4242, unref() {} }; } });
  assert.equal(pid, 4242);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args.slice(1), ['--bg-sync', '/home/user/x', 'abc123']);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.equal(startBackgroundSync('/x', { spawnFn: () => { throw new Error('no'); } }), null, 'a spawn failure is swallowed');
  const withJob = formatFetchFailedMessage('/x', 'Tue', 4242);
  assert.match(withJob, /background catch-up is already running \(pid 4242\)/);
  assert.match(withJob, /do NOT run the merge by hand/);
  assert.doesNotMatch(formatFetchFailedMessage('/x', 'Tue'), /background catch-up/);
});

test('startBackgroundSync pins the checkout HEAD itself when the caller gives none', () => {
  const { startBackgroundSync } = require('../lib/code-checkout-staleness.js');
  const t = makeStaleClone();
  try {
    const head = t.sh(t.stale, 'git rev-parse HEAD');
    const seen = [];
    startBackgroundSync(t.stale, { spawnFn: (cmd, args) => { seen.push(args); return { pid: 1, unref() {} }; } });
    assert.deepEqual(seen[0].slice(1), ['--bg-sync', t.stale, head]);
  } finally { t.cleanup(); }
});

test('session-start.sh starts the background catch-up when the startup fetch fails', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, '.claude', 'hooks', 'session-start.sh'), 'utf8');
  assert.match(src, /lib\.startBackgroundSync\(repoDir\)/);
});
