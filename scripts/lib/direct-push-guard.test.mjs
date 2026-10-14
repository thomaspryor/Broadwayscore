// scripts/lib/direct-push-guard.test.mjs
//
// BRO-3425 / BRO-3873 step 5: scripts/hooks/pre-push refuses a session's
// direct push to main; bots (CI, push-with-retry.sh) keep theirs. The
// decision lives in scripts/lib/direct-push-guard.sh and is invoked here
// through bash (CLAUDE.md rule 15). The last test runs the REAL hook end to
// end against a scratch repo so the wiring (stdin spec → decision → exit 1 +
// message + ledger row) is covered, not just the function.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.resolve(new URL('.', import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, '..', '..');
const LIB = path.join(HERE, 'direct-push-guard.sh');
const HOOK = path.join(REPO_ROOT, 'scripts', 'hooks', 'pre-push');
const REFUSAL = 'land via scripts/merge-worktree-to-main.sh (land/** branch) — direct pushes to main are refused (BRO-3425)';

// The suite itself runs inside GitHub Actions, where GITHUB_ACTIONS/CI are
// always set — a test reading the ambient env would silently exercise the
// allow:ci path while appearing to cover refusal. Every call scrubs them.
function decide(remoteRef, env = {}, changedFile = '') {
  const r = spawnSync('bash', ['-c', `source "$1"; direct_push_guard_decision "$2" "$3"`, '_', LIB, remoteRef, changedFile], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 10_000,
  });
  assert.equal(r.status, 0, `bash exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

test('a session push to refs/heads/main with no bot context → refuse', () => {
  assert.equal(decide('refs/heads/main'), 'refuse');
  assert.equal(decide('refs/heads/master'), 'refuse');
});

test('CI and the push-with-retry bot marker are allowed; land/** and feature refs are never gated', () => {
  assert.equal(decide('refs/heads/main', { GITHUB_ACTIONS: 'true' }), 'allow:ci');
  assert.equal(decide('refs/heads/main', { CI: 'true' }), 'allow:ci');
  assert.equal(decide('refs/heads/main', { CI: 'false' }), 'refuse');
  assert.equal(decide('refs/heads/main', { PUSH_WITH_RETRY_CALLER: 'bot' }), 'allow:push-with-retry-bot');
  assert.equal(decide('refs/heads/main', { PUSH_WITH_RETRY_CALLER: 'session' }), 'refuse');
  // a local `node scripts/land.js` push is a direct push like any other (no actor marker)
  assert.equal(decide('refs/heads/main', { LAND_ACTOR: 'land-branch' }), 'refuse');
  assert.equal(decide('refs/heads/land/worktree-x'), 'allow:not-main');
  assert.equal(decide('refs/heads/worktree-x'), 'allow:not-main');
});

test('rollback flags: LAND_LEGACY_DIRECT=1 and LAND_ENFORCE_OFF=1 allow (and name the flag)', () => {
  assert.equal(decide('refs/heads/main', { LAND_LEGACY_DIRECT: '1' }), 'allow:LAND_LEGACY_DIRECT');
  assert.equal(decide('refs/heads/main', { LAND_ENFORCE_OFF: '1' }), 'allow:LAND_ENFORCE_OFF');
  assert.equal(decide('refs/heads/main', { LAND_LEGACY_DIRECT: '0' }), 'refuse');
});

test('path scope: a push touching no code path is allow:data-only; any code path refuses; an unknown change set refuses', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dpg-paths-'));
  const data = path.join(d, 'data.txt'); fs.writeFileSync(data, 'data/audit/alert-ledger.json\ncloud-memory/MEMORY.md\ndata/review-texts/x/y.json\npublic/data/shows/x.json\n');
  const code = path.join(d, 'code.txt'); fs.writeFileSync(code, 'data/shows.json\nscripts/lib/foo.js\n');
  const wf = path.join(d, 'wf.txt'); fs.writeFileSync(wf, '.github/workflows/x.yml\n');
  const cfg = path.join(d, 'cfg.txt'); fs.writeFileSync(cfg, 'package.json\n');
  const empty = path.join(d, 'empty.txt'); fs.writeFileSync(empty, '');
  assert.equal(decide('refs/heads/main', {}, data), 'allow:data-only');
  assert.equal(decide('refs/heads/main', {}, code), 'refuse');
  assert.equal(decide('refs/heads/main', {}, wf), 'refuse');
  assert.equal(decide('refs/heads/main', {}, cfg), 'refuse');
  assert.equal(decide('refs/heads/main', {}, empty), 'refuse');
  assert.equal(decide('refs/heads/main', {}, path.join(d, 'missing.txt')), 'refuse');
});

// ── the real hook, end to end ───────────────────────────────────────────────
function scratchRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dpg-hook-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: d, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(d, 'scripts', 'lib'), { recursive: true });
  // The hook resolves its libs from REPO_ROOT (the pushing checkout); a
  // scratch repo carries only the guard lib, so every later gate that needs
  // landing-verify.js / run-push-audits.sh takes its documented fallback.
  fs.copyFileSync(LIB, path.join(d, 'scripts', 'lib', 'direct-push-guard.sh'));
  fs.writeFileSync(path.join(d, 'x.txt'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD');
  return { d, sha };
}

function runHook(cwd, spec, env = {}) {
  return spawnSync('bash', [HOOK, 'origin', 'https://example.invalid/repo.git'], {
    cwd,
    input: `${spec}\n`,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    timeout: 60_000,
  });
}

test('scripts/hooks/pre-push refuses refs/heads/main with the BRO-3425 message and writes a direct-push-refused ledger row', () => {
  const { d, sha } = scratchRepo();
  const ledger = path.join(d, 'data', 'audit', 'dispatch-ledger.jsonl');
  const r = runHook(d, `refs/heads/main ${sha} refs/heads/main ${sha}`);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(r.stdout.includes(REFUSAL), `refusal message missing from:\n${r.stdout}`);
  assert.ok(fs.existsSync(ledger), 'ledger row not written');
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.at(-1).event, 'direct-push-refused');
  assert.equal(rows.at(-1).remoteRef, 'refs/heads/main');
  assert.equal(rows.at(-1).localOid, sha);
});

test('scripts/hooks/pre-push allows a data-only push to main (session-stop memory sync shape) without a refusal', () => {
  const { d, sha } = scratchRepo();
  fs.mkdirSync(path.join(d, 'cloud-memory'), { recursive: true });
  fs.writeFileSync(path.join(d, 'cloud-memory', 'MEMORY.md'), 'sync\n');
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['commit', '-q', '-m', 'memory sync'], { cwd: d });
  const tip = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: d, encoding: 'utf8' }).stdout.trim();
  const r = runHook(d, `refs/heads/main ${tip} refs/heads/main ${sha}`);
  assert.ok(!r.stdout.includes(REFUSAL), `data-only push must not be refused:\n${r.stdout}`);
  assert.ok(!fs.existsSync(path.join(d, 'data', 'audit', 'dispatch-ledger.jsonl')), 'data-only allows are not logged');
});

test('scripts/hooks/pre-push lets a land/** push through the refusal (it reaches the later gates)', () => {
  const { d, sha } = scratchRepo();
  const r = runHook(d, `refs/heads/main ${sha} refs/heads/land/worktree-x 0000000000000000000000000000000000000000`);
  assert.ok(!r.stdout.includes(REFUSAL), `land/** push must not be refused:\n${r.stdout}`);
  assert.ok(!fs.existsSync(path.join(d, 'data', 'audit', 'dispatch-ledger.jsonl')), 'no ledger row for a land/** push');
});

test('scripts/hooks/pre-push with LAND_ENFORCE_OFF=1 allows main and logs direct-push-allowed', () => {
  const { d, sha } = scratchRepo();
  const r = runHook(d, `refs/heads/main ${sha} refs/heads/main ${sha}`, { LAND_ENFORCE_OFF: '1' });
  assert.ok(!r.stdout.includes(REFUSAL), `must not refuse under LAND_ENFORCE_OFF=1:\n${r.stdout}`);
  const rows = fs.readFileSync(path.join(d, 'data', 'audit', 'dispatch-ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.at(-1).event, 'direct-push-allowed');
  assert.equal(rows.at(-1).decision, 'allow:LAND_ENFORCE_OFF');
});
