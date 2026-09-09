// tests/unit/settings-hook-paths.test.mjs
//
// BRO-2439 (P1): every hook "command" in .claude/settings.json used to be a
// bare relative path ("bash .claude/hooks/x.sh") that only resolved when the
// Bash tool's cwd happened to equal the repo root. From any other cwd (the
// core-data clone, a scratchpad, os.tmpdir()) bash printed "No such file or
// directory" and exited 127 — a code Claude Code does NOT treat as a hook
// block, so every safety gate silently failed open instead of blocking.
//
// This does two things:
//   1. Reuses the REAL parsing/resolution functions from
//      scripts/lib/infra-gate-registration-check.js (CLAUDE.md rule 15 — no
//      hand-rolled reimplementation of settings.json parsing) to statically
//      confirm every hook command still extracts to, and resolves against,
//      an existing hook file.
//   2. Actually SPAWNS each hook command's shell text with cwd forced to
//      os.tmpdir() (never the repo root) to prove the fix holds at runtime,
//      not just on paper — the exact scenario the original bug lived in.
//      To keep this safe/fast/side-effect-free it never lets a resolved
//      command reach the real hook body (some hooks do real I/O — network
//      pulls, data bootstrap): the trailing `exec bash "$H"` is swapped for
//      `echo RESOLVED:"$H"` before spawning, so only the RESOLVER portion of
//      each command actually runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { extractHookCommandPaths, resolveHookPath } = require('../../scripts/lib/infra-gate-registration-check.js');

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const SETTINGS_PATH = path.join(REPO_ROOT, '.claude', 'settings.json');
const HOOK_TIMEOUT_MS = 10_000;

function loadSettings() {
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

function allHookCommands(settings) {
  const { matched, unmatched } = extractHookCommandPaths(settings);
  assert.deepEqual(unmatched, [], `every hook command must resolve a .sh path; unmatched: ${JSON.stringify(unmatched)}`);
  return matched;
}

// The bare form the original bug shipped as. Any survivor of this shape
// resolves only when cwd === repo root, reproducing the P1.
const BARE_RELATIVE_RE = /^bash \.claude\/hooks\/[^\s]+\.sh$/;

test('no hook command in .claude/settings.json uses the old bare-relative form', () => {
  const settings = loadSettings();
  const { matched } = extractHookCommandPaths(settings);
  assert.ok(matched.length >= 10, `expected at least 10 registered hook commands, found ${matched.length}`);
  for (const { command } of matched) {
    assert.ok(!BARE_RELATIVE_RE.test(command), `still using the cwd-dependent bare form: ${command}`);
  }
});

test('every extracted hook path resolves to an existing file under the repo (static check via the real hook-liveness lib)', () => {
  const settings = loadSettings();
  for (const entry of allHookCommands(settings)) {
    const absPath = resolveHookPath(entry.rawPath, { homeDir: os.homedir(), baseDir: REPO_ROOT });
    assert.ok(fs.existsSync(absPath), `${entry.rawPath} (from command "${entry.command}") does not resolve to an existing file at ${absPath}`);
  }
});

// Swap the terminal `exec bash "$H"` for a side-effect-free marker so the
// spawned subprocess proves resolution without ever running the real hook
// body (some hook bodies do network/data I/O that must not fire from a test).
function withEchoInsteadOfExec(command) {
  const marker = 'exec bash "$H"';
  assert.ok(command.includes(marker), `expected every resolver command to contain literal ${marker}: ${command}`);
  return command.replace(marker, 'echo "RESOLVED:$H"');
}

function runResolver(command, { cwd, env }) {
  return spawnSync('bash', ['-c', withEchoInsteadOfExec(command)], {
    cwd,
    env,
    input: '{}',
    encoding: 'utf8',
    timeout: HOOK_TIMEOUT_MS,
  });
}

test('every hook command resolves to an existing file when cwd is NOT the repo root and CLAUDE_PROJECT_DIR is set (the real fix)', () => {
  const settings = loadSettings();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-hook-paths-'));
  try {
    for (const entry of allHookCommands(settings)) {
      const r = runResolver(entry.command, {
        cwd: tmp,
        env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, PATH: process.env.PATH },
      });
      assert.equal(r.status, 0, `expected resolver to succeed for ${entry.rawPath}; stderr: ${r.stderr}`);
      assert.match(r.stdout, /^RESOLVED:/, `expected a RESOLVED marker for ${entry.rawPath}; got stdout=${r.stdout} stderr=${r.stderr}`);
      const resolvedPath = r.stdout.trim().replace(/^RESOLVED:/, '');
      assert.ok(fs.existsSync(resolvedPath), `resolver claimed ${resolvedPath} for ${entry.rawPath} but it does not exist`);
      assert.ok(resolvedPath.startsWith(REPO_ROOT), `resolver for ${entry.rawPath} escaped the repo root: ${resolvedPath}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('every hook command falls back to git rev-parse --show-toplevel when CLAUDE_PROJECT_DIR is unset but cwd is inside the repo', () => {
  const settings = loadSettings();
  const cwdInsideRepo = path.join(REPO_ROOT, 'scripts');
  const env = { ...process.env, PATH: process.env.PATH };
  delete env.CLAUDE_PROJECT_DIR;
  for (const entry of allHookCommands(settings)) {
    const r = runResolver(entry.command, { cwd: cwdInsideRepo, env });
    assert.equal(r.status, 0, `expected git-rev-parse fallback to succeed for ${entry.rawPath}; stderr: ${r.stderr}`);
    const resolvedPath = r.stdout.trim().replace(/^RESOLVED:/, '');
    assert.ok(fs.existsSync(resolvedPath), `git-fallback resolver claimed ${resolvedPath} for ${entry.rawPath} but it does not exist`);
  }
});

test('every hook command FAILS LOUDLY with exit 2 (not a silent allow) when it cannot resolve a repo root at all', () => {
  const settings = loadSettings();
  const outsideAnyRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-hook-paths-outside-'));
  try {
    // GIT_CEILING_DIRECTORIES stops git from walking up past this boundary,
    // so the "not in a git repo" assumption holds even if the CI runner's
    // tmpdir happens to sit under some unrelated ancestor .git.
    const env = { ...process.env, PATH: process.env.PATH, GIT_CEILING_DIRECTORIES: path.dirname(outsideAnyRepo) };
    delete env.CLAUDE_PROJECT_DIR;
    for (const entry of allHookCommands(settings)) {
      const r = runResolver(entry.command, { cwd: outsideAnyRepo, env });
      assert.equal(r.status, 2, `expected exit 2 (Claude Code's hook-block code) for unresolvable ${entry.rawPath}, got ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
      assert.match(r.stderr, /FATAL/, `expected a loud FATAL message for unresolvable ${entry.rawPath}; got stderr=${r.stderr}`);
      assert.doesNotMatch(r.stdout, /^RESOLVED:/, `must not resolve to allowed for ${entry.rawPath}`);
    }
  } finally {
    fs.rmSync(outsideAnyRepo, { recursive: true, force: true });
  }
});

test('sanity: os.tmpdir() truly sits outside this git repo (GIT_CEILING_DIRECTORIES precondition holds)', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-hook-paths-precondition-'));
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: outside,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(outside) },
      encoding: 'utf8',
      timeout: HOOK_TIMEOUT_MS,
    });
    assert.notEqual(r.status, 0, 'test precondition broken: tmpdir resolves to a real git repo even with GIT_CEILING_DIRECTORIES set');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
