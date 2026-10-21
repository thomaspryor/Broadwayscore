// tests/unit/pre-push-visual-gate-fixture.test.mjs — BRO-2312.
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
import { spawnSyncStdinFile } from '../helpers/spawn-stdin-file.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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

const NEUTRAL_USER = 'please check the spacing in the header';

// Sanity: the hook's libs, resolved exactly as the hook resolves them, really
// execute and answer. Without this an inert lib would make the exit-0 cases
// (controls, approval) pass for the wrong reason.
test('fixture: real libs run through $CANONICAL_ROOT/scripts with the hook env', (t) => {
  const fx = makeFixture(t);
  const r = spawnSync('node', [join(fx.repo, 'scripts', 'lib', 'transcript-scan.mjs'), '--query=push-ingress', `--command=${PUSH_CMD}`], {
    cwd: fx.repo, encoding: 'utf8', env: hookEnv(fx, fx.home),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).isPush, true, `push-ingress query returned: ${r.stdout}`);
});

test('(1) UI change + no verdict -> exit 2 BLOCKED', (t) => {
  const fx = makeFixture(t);
  assertGateLive(fx);
  const r = runHook(fx, writeTranscript(fx, NEUTRAL_USER));
  assert.equal(r.status, 2, `expected block, got ${r.status}. stderr: ${r.stderr}`);
  assert.match(r.stderr, /BLOCKED: push of UI changes without a visual-qa verdict/);
  assert.match(r.stderr, new RegExp(`branch ${BRANCH}`));
  assert.ok(r.stderr.includes(UI_FILE), `stderr should name the UI file: ${r.stderr}`);
});

test('(2) verdict schemaVersion 1 -> exit 2 stale schema', (t) => {
  const fx = makeFixture(t);
  assertGateLive(fx);
  writeVerdict(fx, { schemaVersion: 1, overallPass: true, contentHash: HASH });
  const r = runHook(fx, writeTranscript(fx, NEUTRAL_USER));
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /verdict\.json is stale schema \(v1, need v2\)/);
});

test('(2b) verdict with no schemaVersion defaults to v1 -> exit 2 stale schema', (t) => {
  const fx = makeFixture(t);
  writeVerdict(fx, { overallPass: true, contentHash: HASH });
  const r = runHook(fx, writeTranscript(fx, NEUTRAL_USER));
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /stale schema \(v1, need v2\)/);
});

test('(3) valid v2 verdict with contentHash but no approval -> exit 2', (t) => {
  const fx = makeFixture(t);
  assertGateLive(fx);
  writeVerdict(fx, { schemaVersion: 2, overallPass: true, contentHash: HASH });
  const r = runHook(fx, writeTranscript(fx, NEUTRAL_USER));
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /passing visual-qa verdict exists \(overallPass=true\) but the user has not yet approved it/);
  assert.equal(existsSync(fx.ledger), false, 'a blocked push must not write a ledger approval');
});

test('(3b) negated affirmative ("looks good but fix X first") does not approve -> exit 2', (t) => {
  const fx = makeFixture(t);
  writeVerdict(fx, { schemaVersion: 2, overallPass: true, contentHash: HASH });
  const r = runHook(fx, writeTranscript(fx, 'looks good but fix the padding first'));
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /has not yet approved it/);
});

test('(4) plain user approval -> exit 0, ledger row recorded, and the ledger alone then allows', (t) => {
  const fx = makeFixture(t);
  assertGateLive(fx);
  writeVerdict(fx, { schemaVersion: 2, overallPass: true, contentHash: HASH });
  const head = git(fx.repo, 'rev-parse', 'HEAD');

  const r = runHook(fx, writeTranscript(fx, 'ship it'));
  assert.equal(r.status, 0, `expected allow, got ${r.status}. stderr: ${r.stderr}`);

  assert.ok(existsSync(fx.ledger), `approval ledger not written at ${fx.ledger}`);
  const rows = readFileSync(fx.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, `expected exactly one ledger row: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].contentHash, HASH);
  assert.equal(rows[0].commitSha, head);
  assert.equal(rows[0].branch, BRANCH);
  assert.equal(rows[0].sessionId, 'sess-fixture-bro2312');

  // Ledger inheritance: same verdict, no approval in the transcript any more,
  // and the push is still allowed via the recorded row (no second row added).
  const r2 = runHook(fx, writeTranscript(fx, NEUTRAL_USER, 'transcript-2.jsonl'));
  assert.equal(r2.status, 0, `ledger should allow re-push. stderr: ${r2.stderr}`);
  const rows2 = readFileSync(fx.ledger, 'utf8').split('\n').filter(Boolean);
  assert.equal(rows2.length, 1, 'ledger-allowed push must not append another row');
});

test('(4b) explicit "APPROVED: <hash>" approves only the named verdict', (t) => {
  const fx = makeFixture(t);
  writeVerdict(fx, { schemaVersion: 2, overallPass: true, contentHash: HASH });
  const wrong = runHook(fx, writeTranscript(fx, 'APPROVED: 0000000000000000', 'wrong.jsonl'));
  assert.equal(wrong.status, 2, `approval of a different hash must not pass. stderr: ${wrong.stderr}`);
  const right = runHook(fx, writeTranscript(fx, `APPROVED: ${HASH}`, 'right.jsonl'));
  assert.equal(right.status, 0, `stderr: ${right.stderr}`);
  assert.ok(existsSync(fx.ledger));
});

test('control: non-UI-only branch -> exit 0 with no verdict', (t) => {
  const fx = makeFixture(t, { uiBranch: false });
  assertGateLive(fx);
  const r = runHook(fx, writeTranscript(fx, NEUTRAL_USER));
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(r.stderr, '');
});

test('control: a non-push command is ignored even on a UI branch', (t) => {
  const fx = makeFixture(t);
  const r = runHook(fx, writeTranscript(fx, NEUTRAL_USER), { command: 'git status' });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
});

// Negative control. With a master copy at $HOME/.claude/hooks/<name> the hook
// self-skips and exits 0 even though case (1)'s exact block conditions hold.
// That is the inert path; the main cases above assert its absence
// (assertGateLive) and observe exit 2, so a green run here cannot be produced
// by the self-skip, by a missing lib, or by a fail-open early return.
test('negative control: HOME self-skip exits 0 with no verdict (the inert path)', (t) => {
  const fx = makeFixture(t);
  const inertHome = join(fx.root, 'inert-home');
  mkdirSync(join(inertHome, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(inertHome, '.claude', 'hooks', HOOK_NAME), '#!/bin/sh\nexit 0\n');
  const transcript = writeTranscript(fx, NEUTRAL_USER);

  const inert = runHook(fx, transcript, { home: inertHome });
  assert.equal(inert.status, 0, 'self-skip path should exit 0');
  assert.equal(inert.stderr, '', 'self-skip path should be silent');

  // Same fixture, live HOME: blocked. Proves the difference is the self-skip.
  const live = runHook(fx, transcript);
  assert.equal(live.status, 2, `live HOME should block. stderr: ${live.stderr}`);
});

// BRO-5844: copy-only edits to a src/app code file do not need visual approval.
function withUiBase(fx, base) {
  git(fx.repo, 'checkout', '-q', 'main');
  commitFile(fx.repo, 'src/app/copy/page.tsx', base, 'ui: base page');
  git(fx.repo, 'push', '-q', 'origin', 'main');
  git(fx.repo, 'fetch', '-q', 'origin');
  git(fx.repo, 'checkout', '-q', BRANCH);
  git(fx.repo, 'rebase', '-q', 'main');
}

test('(BRO-5844) text-only edit to a src/app page.tsx -> exit 0 with no verdict', (t) => {
  const fx = makeFixture(t, { uiBranch: false });
  assertGateLive(fx);
  withUiBase(fx, 'export default function P() {\n  return <p className="a">Old words</p>;\n}\n');
  commitFile(fx.repo, 'src/app/copy/page.tsx', 'export default function P() {\n  return <p className="a">New words</p>;\n}\n', 'copy edit');
  const r = runHook(fx, writeTranscript(fx, NEUTRAL_USER));
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
});

test('(BRO-5844) className edit to the same file -> still blocked', (t) => {
  const fx = makeFixture(t, { uiBranch: false });
  assertGateLive(fx);
  withUiBase(fx, 'export default function P() {\n  return <p className="a">Old words</p>;\n}\n');
  commitFile(fx.repo, 'src/app/copy/page.tsx', 'export default function P() {\n  return <p className="b">Old words</p>;\n}\n', 'style edit');
  const r = runHook(fx, writeTranscript(fx, NEUTRAL_USER));
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /without a visual-qa verdict/);
});

test('(BRO-5844) a visual file after 5 text-only files is not hidden by the head -5 cut', (t) => {
  const fx = makeFixture(t, { uiBranch: false });
  assertGateLive(fx);
  git(fx.repo, 'checkout', '-q', 'main');
  for (let i = 1; i <= 6; i++) commitFile(fx.repo, `src/app/p${i}/page.tsx`, `export default () => <p className="a">Old</p>;\n`, `base ${i}`);
  git(fx.repo, 'push', '-q', 'origin', 'main');
  git(fx.repo, 'fetch', '-q', 'origin');
  git(fx.repo, 'checkout', '-q', BRANCH);
  git(fx.repo, 'rebase', '-q', 'main');
  for (let i = 1; i <= 5; i++) commitFile(fx.repo, `src/app/p${i}/page.tsx`, `export default () => <p className="a">New ${i}</p>;\n`, `copy ${i}`);
  commitFile(fx.repo, 'src/app/p6/page.tsx', `export default () => <p className="z">Old</p>;\n`, 'style 6');
  const r = runHook(fx, writeTranscript(fx, NEUTRAL_USER));
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
});
