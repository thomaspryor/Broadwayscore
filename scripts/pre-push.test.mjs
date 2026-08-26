// scripts/pre-push.test.mjs
//
// BRO-124: scripts/hooks/pre-push previously only checked CLAUDE.md for
// reverted critical sections — the 14336B byte cap that
// .github/workflows/test.yml's Lint Workflows job enforces was CI-only, so an
// overage surfaced only after push. Two extracted pieces now close that gap
// (CLAUDE.md rule 15 — require()/invoke the real logic, don't restate it
// here):
//   - scripts/lib/check-claude-md-byte-cap.js — pure byte-count decision fn
//     + CLI wrapper (reads CLAUDE.md content from stdin, config path from argv).
//   - scripts/lib/claude-md-byte-cap-gate.sh — git-plumbing wrapper that gets
//     a ref's COMMITTED CLAUDE.md into the CLI above via a temp file (not a
//     pipe — a pipe breaks under pre-push's `set -o pipefail` when CLAUDE.md
//     doesn't exist at the ref, e.g. a push that deletes it: git show exits
//     non-zero, node exits 0 on empty stdin, and pipefail would report the
//     pipeline as failed anyway, falsely BLOCKING a deletion).
//
// Three layers:
//   1. Unit tests against checkByteCap() directly — fast, no subprocess.
//   2. CLI smoke tests for check-claude-md-byte-cap.js's stdin/argv wiring.
//   3. Git-fixture integration tests against claude-md-byte-cap-gate.sh — the
//      exact command scripts/hooks/pre-push runs, including the deletion
//      case that motivated the temp-file-not-a-pipe design.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkByteCap } from './lib/check-claude-md-byte-cap.js';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'check-claude-md-byte-cap.js');
const GATE_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'claude-md-byte-cap-gate.sh');

function makeAnchorsFile(dir, byteLimit) {
  const p = path.join(dir, 'anchors.json');
  fs.writeFileSync(p, JSON.stringify({ anchors: [], byteLimit }));
  return p;
}

function runCli(anchorsPath, mdContent) {
  return spawnSync('node', [CLI_PATH, anchorsPath], {
    input: mdContent,
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
  });
}

// ── unit tests: checkByteCap() ──────────────────────────────────────────────

test('checkByteCap: content under the limit passes', () => {
  const result = checkByteCap('a'.repeat(100), { byteLimit: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 100);
  assert.equal(result.limit, 200);
});

test('checkByteCap: content exactly at the limit passes (boundary is inclusive)', () => {
  const result = checkByteCap('a'.repeat(200), { byteLimit: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, 200);
});

test('checkByteCap: content over the limit fails', () => {
  const result = checkByteCap('a'.repeat(201), { byteLimit: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.bytes, 201);
  assert.equal(result.limit, 200);
});

test('checkByteCap: counts bytes, not characters — multi-byte UTF-8 content over a char-count-but-not-byte-count boundary still fails', () => {
  // Each '€' is 3 bytes in UTF-8. 100 of them is 100 chars / 300 bytes.
  const result = checkByteCap('€'.repeat(100), { byteLimit: 250 });
  assert.equal(result.ok, false);
  assert.equal(result.bytes, 300);
});

test('checkByteCap: no byteLimit configured fails open (ok: true)', () => {
  const result = checkByteCap('a'.repeat(999999), {});
  assert.equal(result.ok, true);
  assert.equal(result.limit, null);
});

test('checkByteCap: matches the real scripts/lib/claude-md-anchors.json byteLimit and the real CLAUDE.md currently passes it', () => {
  const anchorsPath = path.join(REPO_ROOT, 'scripts', 'lib', 'claude-md-anchors.json');
  const cfg = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
  assert.equal(cfg.byteLimit, 14336, 'update this pin if the cap is deliberately changed');
  const md = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
  const result = checkByteCap(md, cfg);
  assert.equal(result.ok, true, `real CLAUDE.md is ${result.bytes}B, over the ${result.limit}B cap — fix CLAUDE.md before this test suite can pass`);
});

// ── CLI smoke tests: check-claude-md-byte-cap.js's stdin/argv wiring ───────

test('CLI: exits 1 and prints the overage on stdout/stderr when CLAUDE.md content exceeds the cap', () => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-cap-test-'));
  try {
    const anchorsPath = makeAnchorsFile(tdir, 50);
    const r = runCli(anchorsPath, 'x'.repeat(51));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /over the 50B cap/);
  } finally {
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

test('CLI: exits 0 when CLAUDE.md content is within the cap', () => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-cap-test-'));
  try {
    const anchorsPath = makeAnchorsFile(tdir, 50);
    const r = runCli(anchorsPath, 'x'.repeat(50));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /CLAUDE\.md OK/);
  } finally {
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

test('CLI: fails open (exit 0) when the anchors config path does not exist', () => {
  const r = runCli('/nonexistent/anchors.json', 'x'.repeat(999999));
  assert.equal(r.status, 0);
});

test('CLI: fails open (exit 0) on malformed anchors JSON', () => {
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-cap-test-'));
  try {
    const anchorsPath = path.join(tdir, 'anchors.json');
    fs.writeFileSync(anchorsPath, 'not json');
    const r = runCli(anchorsPath, 'x'.repeat(999999));
    assert.equal(r.status, 0);
  } finally {
    fs.rmSync(tdir, { recursive: true, force: true });
  }
});

// ── git-fixture integration tests: claude-md-byte-cap-gate.sh ──────────────
//
// Throwaway repo (not this project's own history) carrying just enough
// structure for the gate script to run against: scripts/lib/check-claude-md-
// byte-cap.js (copied verbatim from the real file) + a claude-md-anchors.json
// with a small byteLimit, plus a sequence of commits that vary CLAUDE.md.
// Every git call is bounded (timeout) so a hang fails as a named error
// instead of eating the whole file's budget (same rationale as
// scripts/tests/merge-gate-hook.test.mjs).

const GIT_TIMEOUT_MS = 15_000;
let fixtureDir = null;
let refInCap = null;
let refOverCap = null;
let refDeleted = null;
let fixtureError = null;

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
}
function gitOut(cwd, args) {
  const r = git(cwd, args);
  return (r.stdout || '').trim();
}

before(() => {
  try {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-gate-fixture-'));
    git(fixtureDir, ['init', '-q']);
    fs.mkdirSync(path.join(fixtureDir, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(CLI_PATH, path.join(fixtureDir, 'scripts', 'lib', 'check-claude-md-byte-cap.js'));
    fs.writeFileSync(path.join(fixtureDir, 'scripts', 'lib', 'claude-md-anchors.json'), JSON.stringify({ anchors: [], byteLimit: 50 }));

    const commit = (msg) => git(fixtureDir, ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', msg]);

    fs.writeFileSync(path.join(fixtureDir, 'CLAUDE.md'), 'x'.repeat(50));
    git(fixtureDir, ['add', '-A']);
    commit('in-cap CLAUDE.md (50B, limit 50B)');
    refInCap = gitOut(fixtureDir, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(fixtureDir, 'CLAUDE.md'), 'x'.repeat(51));
    git(fixtureDir, ['add', '-A']);
    commit('over-cap CLAUDE.md (51B, limit 50B)');
    refOverCap = gitOut(fixtureDir, ['rev-parse', 'HEAD']);

    fs.rmSync(path.join(fixtureDir, 'CLAUDE.md'));
    git(fixtureDir, ['add', '-A']);
    commit('delete CLAUDE.md');
    refDeleted = gitOut(fixtureDir, ['rev-parse', 'HEAD']);
  } catch (err) {
    fixtureError = err;
  }
});

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
});

const skipNoFixture = { get skip() { return (!fixtureDir || !refInCap || !refOverCap || !refDeleted) && `fixture repo failed to build: ${fixtureError}`; } };

function runGate(ref) {
  return spawnSync('bash', [GATE_PATH, fixtureDir, ref], {
    cwd: fixtureDir,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
}

test('gate.sh: exits 0 for a ref whose CLAUDE.md is within the cap', skipNoFixture, () => {
  const r = runGate(refInCap);
  assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
});

test('gate.sh: exits 1 for a ref whose CLAUDE.md exceeds the cap', skipNoFixture, () => {
  const r = runGate(refOverCap);
  assert.equal(r.status, 1);
});

test('gate.sh: exits 0 (fails open) for a ref that DELETES CLAUDE.md — the pipefail regression this gate exists to avoid', skipNoFixture, () => {
  const r = runGate(refDeleted);
  assert.equal(r.status, 0, `a deleted CLAUDE.md must never block a push; got exit ${r.status}, stdout: ${r.stdout} stderr: ${r.stderr}`);
});

// Negative control: prove the deletion test above has teeth by reintroducing
// the exact pipe-based bug (`git show ... | node ...` under pipefail) in a
// patched copy of the gate and confirming it WOULD wrongly block a deletion.
test('regression pin: a pipe-based rewrite of gate.sh (no temp file) wrongly BLOCKS a CLAUDE.md deletion under pipefail', skipNoFixture, () => {
  const original = fs.readFileSync(GATE_PATH, 'utf8');
  const buggy = original
    .replace(/^set -u$/m, 'set -uo pipefail')
    .replace(
      /git show "\$REF:CLAUDE\.md" >"\$TMP_MD" 2>\/dev\/null \|\| exit 0\n\nnode[^\n]*<"\$TMP_MD"\n/,
      'git show "$REF:CLAUDE.md" 2>/dev/null | node "$REPO_ROOT/scripts/lib/check-claude-md-byte-cap.js" "$REPO_ROOT/scripts/lib/claude-md-anchors.json"\n'
    );
  assert.notEqual(buggy, original, 'the buggy-rewrite regex no longer matches gate.sh — update this pin to match its current form');
  const buggyPath = path.join(fixtureDir, '..', `gate-buggy-${path.basename(fixtureDir)}.sh`);
  fs.writeFileSync(buggyPath, buggy);
  try {
    const r = spawnSync('bash', [buggyPath, fixtureDir, refDeleted], {
      cwd: fixtureDir,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    assert.notEqual(r.status, 0, 'the buggy pipe-based version should wrongly BLOCK a deletion — proving this suite would have caught the real bug');
  } finally {
    fs.rmSync(buggyPath, { force: true });
  }
});

// ── hook wiring: scripts/hooks/pre-push calls the gate on the byte-cap path ─

test('scripts/hooks/pre-push invokes claude-md-byte-cap-gate.sh', () => {
  const hookSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'hooks', 'pre-push'), 'utf8');
  assert.match(hookSrc, /claude-md-byte-cap-gate\.sh/, 'pre-push hook no longer wires in the byte-cap gate');
});

test('scripts/lib/claude-md-byte-cap-gate.sh invokes check-claude-md-byte-cap.js against claude-md-anchors.json', () => {
  const gateSrc = fs.readFileSync(GATE_PATH, 'utf8');
  assert.match(gateSrc, /check-claude-md-byte-cap\.js/, 'gate script no longer wires in the byte-cap decision fn');
  assert.match(gateSrc, /claude-md-anchors\.json/, 'gate script no longer passes claude-md-anchors.json to the byte-cap check');
});
