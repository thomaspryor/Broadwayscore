// scripts/pre-push-visual-gate.test.mjs — BRO-5402 regression guard (built on the
// BRO-2312 hermetic fixture in tests/unit/pre-push-visual-gate-fixture.test.mjs).
//
// BRO-5402 reported a UI push to land/<name> passing with no owner approval after
// a branch was re-created in the same worktree. On main the hook blocks both
// shapes below, so these pin that behaviour (no hook change was needed).
//
// The Mac-only suite ~/.claude/hooks/tests/pre-push-visual-gate/run.sh skips
// 4 of its 8 cases because the named fixture worktree it depended on
// (.claude/worktrees/mobile-rating-redesign) no longer exists, so the gate's
// core assertion ("blocks a UI push without a verdict") was inert while the
// suite reported green.
//
// This test is the hermetic replacement. Each case builds a throwaway git repo
// in os.tmpdir() with a bare "origin" (so origin/main is real), commits a UI
// file on a feature branch, and runs the REAL hook
// (.claude/hooks/pre-push-visual-gate.sh) against it. The temp repo's
// scripts/ is a symlink to this repo's real scripts/, so the hook's
// $CANONICAL_ROOT/scripts/lib/{transcript-scan,visual-qa-ledger,review-gate}.mjs
// are the real libraries. Nothing from the hook is re-implemented here.
//
// HOME points at an empty temp dir so the hook's "self-skip if
// ~/.claude/hooks/<name> exists" branch does not fire. A negative control
// shows that branch exits 0 with no verdict, which is exactly the inert
// behaviour the main cases must never be exercising.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  symlinkSync, realpathSync, appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSyncStdinFile } from '../tests/helpers/spawn-stdin-file.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(REPO_ROOT, '.claude', 'hooks', 'pre-push-visual-gate.sh');
const REAL_SCRIPTS = join(REPO_ROOT, 'scripts');
const HOOK_NAME = 'pre-push-visual-gate.sh';
const BRANCH = 'feat-ui';
const UI_FILE = 'src/components/Foo.tsx';
const HASH = 'abcdef0123456789';

// The hook fails OPEN when jq is missing (every jq call yields empty, the
// command parse is empty, exit 0). Skipping here would recreate the exact
// "green but inert" problem this test exists to remove, so it fails instead.
test('precondition: jq is installed (the hook fails open without it)', () => {
  const r = spawnSync('sh', ['-c', 'command -v jq'], { encoding: 'utf8' });
  assert.equal(
    r.status, 0,
    'jq is not on PATH. pre-push-visual-gate.sh fails open without jq, so every case below would pass vacuously. Install jq.',
  );
  assert.ok(existsSync(HOOK), `hook not found at ${HOOK}`);
});

// Setup git ignores the caller's global/system config (core.hooksPath,
// init.templateDir, insteadOf rewrites) so the fixture is really hermetic.
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Never inherit GIT_DIR / GIT_WORK_TREE etc. from a parent git hook.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('GIT_')) continue;
    if (k === 'VISUAL_QA_DISABLE' || k === 'VISUAL_QA_LEDGER_TTL_DAYS') continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

function commitFile(repo, relPath, contents, msg) {
  mkdirSync(join(repo, dirname(relPath)), { recursive: true });
  writeFileSync(join(repo, relPath), contents);
  git(repo, 'add', '--', relPath);
  git(repo, 'commit', '-q', '-m', msg);
}

// Builds: <root>/origin.git (bare), <root>/repo (clone-like, origin/main set),
// <root>/home (empty HOME), <root>/logs, <root>/tmp. Registers cleanup on t.
function makeFixture(t, { uiBranch = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pre-push-visual-gate-fixture-')));
  t.after(() => {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    catch (err) { console.warn(`cleanup of ${root} failed: ${err.message}`); }
  });
  const origin = join(root, 'origin.git');
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const logs = join(root, 'logs');
  const tmp = join(root, 'tmp');
  for (const d of [repo, home, logs, tmp]) mkdirSync(d, { recursive: true });

  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  // Global config is nulled above, so CI's global maintenance-off never reaches
  // this bare origin: receive-pack's detached auto-maintenance would race the
  // teardown rmSync (BRO-4749). Set the keys in the bare repo itself.
  for (const [k, v] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['receive.autogc', 'false']]) git(origin, 'config', k, v);
  git(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [
    ['user.email', 'test@example.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false'],
    ['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'],
  ]) git(repo, 'config', k, v);
  git(repo, 'remote', 'add', 'origin', origin);

  // The hook resolves its libs at $CANONICAL_ROOT/scripts/lib/*.mjs; point
  // that at the real scripts dir, untracked so it never enters a diff.
  symlinkSync(REAL_SCRIPTS, join(repo, 'scripts'), 'dir');
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '/scripts\n/.claude/\n');

  commitFile(repo, 'README.md', '# fixture\n', 'base');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  assert.equal(git(repo, 'rev-parse', 'origin/main'), git(repo, 'rev-parse', 'main'));

  git(repo, 'checkout', '-q', '-b', BRANCH);
  if (uiBranch) {
    commitFile(repo, UI_FILE, 'export const Foo = () => null;\n', 'ui: add Foo');
  } else {
    commitFile(repo, 'data/notes.txt', 'backend only\n', 'data: notes');
  }

  return { root, repo, home, logs, tmp, ledger: join(repo, '.claude', 'visual-qa', 'approvals.jsonl') };
}

function writeVerdict(fx, verdict) {
  const dir = join(fx.repo, '.claude', 'visual-qa', BRANCH);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
}

const TOOL_USE_ID = 'toolu_fixture_01';
const PUSH_CMD = `git push origin ${BRANCH}`;

// A realistic transcript: user prompt, assistant turn whose tool_use is the
// gated push. userText is the LAST user text message the approval query reads.
function writeTranscript(fx, userText, name = 'transcript.jsonl') {
  const p = join(fx.root, name);
  const lines = [
    { type: 'user', timestamp: '2026-10-13T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: userText }] } },
    {
      type: 'assistant', timestamp: '2026-10-13T00:00:01Z',
      message: {
        id: 'msg_fixture_01', role: 'assistant',
        content: [
          { type: 'text', text: 'Pushing the branch.' },
          { type: 'tool_use', id: TOOL_USE_ID, name: 'Bash', input: { command: PUSH_CMD } },
        ],
      },
    },
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

// The libs run through the fixture's scripts/ symlink exactly as in
// production: their CLI gate is realpath-aware (scripts/lib/is-main-module.mjs,
// fa3705d2). No --preserve-symlinks-main: that flag masked a regression of the
// helper (BRO-5261 retro-review). The 'libs run through the symlink' test
// below fails loudly if the gate breaks again.
function hookEnv(fx, home) {
  return cleanEnv({ HOME: home, CLAUDE_LOG_DIR: fx.logs, TMPDIR: fx.tmp });
}

function runHook(fx, transcript, { home = fx.home, command = PUSH_CMD } = {}) {
  const input = JSON.stringify({
    tool_input: { command },
    session_id: 'sess-fixture-bro2312',
    transcript_path: transcript,
    tool_use_id: TOOL_USE_ID,
  });
  const r = spawnSyncStdinFile('bash', [HOOK], {
    cwd: fx.repo,
    input,
    encoding: 'utf8',
    env: hookEnv(fx, home),
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}

// Guard used by every main case: the self-skip master must be absent, or the
// case would be exercising the inert path.
function assertGateLive(fx) {
  assert.equal(existsSync(join(fx.home, '.claude', 'hooks', HOOK_NAME)), false,
    'HOME contains a self-skip master hook; the case would test the inert path');
}


function runPush(fx, command) {
  const t = writeTranscript(fx, NEUTRAL_USER);
  return runHook(fx, t, { command });
}
const NEUTRAL_USER = 'please check the spacing in the header';

test('BRO-5402 repro: HEAD:refs/heads/land/x of a UI branch with no verdict is blocked', (t) => {
  const fx = makeFixture(t);
  assertGateLive(fx);
  const r = runPush(fx, 'git push origin HEAD:refs/heads/land/bro-5402-x');
  assert.equal(r.status, 2, r.stderr);
});

test('BRO-5402 repro: renamed branch (verdict under the old name) is blocked', (t) => {
  const fx = makeFixture(t);
  assertGateLive(fx);
  writeVerdict(fx, { schemaVersion: 2, contentHash: HASH, overallPass: true });
  git(fx.repo, 'branch', '-m', BRANCH, 'feat-ui-renamed');
  const r = runPush(fx, 'git push origin HEAD:refs/heads/land/bro-5402-x');
  assert.equal(r.status, 2, r.stderr);
});
