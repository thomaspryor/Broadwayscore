// scripts/tests/notion-card-linear-sentinel.test.mjs
//
// Shell-level test for BRO-2510: a session dispatched onto an EXISTING
// Linear issue (linear-next.js --id BRO-N -> `linear-session.js claim
// --issue=BRO-N`) never runs `notion-brain.js create`/`linear-brain.js
// create`, so it never earns /tmp/notion-card-${session_id} — and was being
// BLOCKED at its first `git commit` (~/.claude/hooks/
// notion-card-required-commit.sh) and again at Stop (~/.claude/hooks/
// notion-card-required-stop.sh), despite linear-issue-verify.sh already
// proving the session is tracked via /tmp/linear-issue-claimed-${session_id}
// (on a successful claim) and /tmp/linear-issue-reported-${session_id} (on a
// successful report). The fix teaches both hooks to accept either sentinel
// as equivalent to the Notion one.
//
// Both hooks live only in the separate ~/.claude claude-config repo (no
// committed copy under this repo's .claude/hooks/, unlike
// pre-merge-review-gate.sh etc.) — same situation as
// scripts/tests/hook-guard-restore.test.mjs's hook-syntax-guard.sh. Every
// test below therefore skips on GitHub Actions (no ~/.claude there) and runs
// for real on a dev machine via
// `node --test scripts/tests/notion-card-linear-sentinel.test.mjs`.
//
// EVERY hook invocation below runs against a FAKE HOME (no
// .claude/BOARD_GATE_DISABLED*) and a FAKE BROADWAYSCORE_REPO whose
// notion-brain.js stub always reports "reachable" — this is not optional
// hygiene. This dev machine had the real fleet-wide kill switch
// (~/.claude/BOARD_GATE_DISABLED) live while this suite was being written,
// which makes both hooks exit 0 unconditionally before ever reaching the
// logic under test — a first draft of this file that used the ambient
// HOME/BROADWAYSCORE_REPO passed 11/11 even with the fix's code block
// deleted entirely. Every test here is written to fail if the Linear-sentinel
// branch is removed, verified by literally removing it and re-running (see
// the BRO-2510 session notes) — not just to pass with the fix present.
//
// Real /tmp sentinel files are used (that's what the hooks actually read),
// scoped to randomUUID() session ids so this suite never collides with a
// live session's own sentinels on a shared dev machine, and cleaned up in a
// `finally` per test.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REAL_HOME = os.homedir();
const COMMIT_HOOK = path.join(REAL_HOME, '.claude', 'hooks', 'notion-card-required-commit.sh');
const STOP_HOOK = path.join(REAL_HOME, '.claude', 'hooks', 'notion-card-required-stop.sh');
const hasHooks = fs.existsSync(COMMIT_HOOK) && fs.existsSync(STOP_HOOK);
const skip = !hasHooks && 'notion-card-required-{commit,stop}.sh live in the separate ~/.claude claude-config repo (expected in CI)';

const HOOK_TIMEOUT_MS = 20_000;

let FAKE_HOME;      // no .claude/BOARD_GATE_DISABLED* — defeats the kill switch
let REACHABLE_REPO; // scripts/notion-brain.js stub that always exits 0 ("reachable")
let SLOW_REPO;      // same, but sleeps 8s first — proves the probe is skipped, not raced

before(() => {
  if (!hasHooks) return;
  FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ncc-fakehome-'));
  fs.mkdirSync(path.join(FAKE_HOME, '.claude'), { recursive: true });
  REACHABLE_REPO = makeFakeRepo('reachable', { exitCode: 0 });
  SLOW_REPO = makeFakeRepo('slow', { exitCode: 0, sleepMs: 8000 });
});

after(() => {
  for (const d of [FAKE_HOME, REACHABLE_REPO, SLOW_REPO]) {
    if (d) fs.rmSync(d, { recursive: true, force: true });
  }
});

function makeFakeRepo(label, { exitCode = 0, sleepMs = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ncc-fakerepo-${label}-`));
  const scriptsDir = path.join(dir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const cliPath = path.join(scriptsDir, 'notion-brain.js');
  fs.writeFileSync(cliPath, `#!/usr/bin/env node\n${sleepMs > 0 ? `setTimeout(() => process.exit(${exitCode}), ${sleepMs});` : `process.exit(${exitCode});`}\n`);
  fs.chmodSync(cliPath, 0o755);
  return dir;
}

// A minimal transcript with ONE assistant message that Edits a tracked path
// (scripts/ prefix, under a /Broadwayscore/ segment — matches
// notion-card-required-stop.sh's own is_tracked_path()). Without the
// Linear-sentinel early-exit, this is exactly the shape that reaches the
// BLOCK branch: edited_tracked=true, closed_a_card=false, no NO-CARD bypass.
function makeTrackedEditTranscript(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ncc-transcript-${label}-`));
  const p = path.join(dir, 'transcript.jsonl');
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/Users/tompryor/Broadwayscore/scripts/some-file.js' } }],
    },
  });
  fs.writeFileSync(p, line + '\n');
  return p;
}

function claimSentinelPath(sessionId) { return `/tmp/linear-issue-claimed-${sessionId}`; }
function reportSentinelPath(sessionId) { return `/tmp/linear-issue-reported-${sessionId}`; }
function cardSentinelPath(sessionId) { return `/tmp/notion-card-${sessionId}`; }

function writeSentinel(p, content = 'test-content') {
  fs.writeFileSync(p, content);
}

function cleanupSentinels(paths) {
  for (const p of paths) {
    try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

// Defaults: fake HOME (kill switch defeated) + fake REACHABLE repo, so every
// "allowed" assertion below is discriminating — if the sentinel branch under
// test were removed, the hook would fall through to a Notion probe that
// reports reachable and BLOCK, not accidentally pass via the machine's own
// live kill switch or a missing/unreachable real notion-brain.js.
function defaultEnv(overrides = {}) {
  return { HOME: FAKE_HOME, BROADWAYSCORE_REPO: REACHABLE_REPO, BOARD_GATE_DISABLED: '0', ...overrides };
}

function runCommitHook({ sessionId, env = {} }) {
  const stdin = JSON.stringify({ tool_input: { command: 'git commit -m "test"' }, session_id: sessionId });
  const r = spawnSync('bash', [COMMIT_HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...defaultEnv(env) },
    timeout: HOOK_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function runStopHook({ sessionId, transcriptPath = '/nonexistent/transcript.jsonl', env = {} }) {
  const stdin = JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, stop_hook_active: false });
  const r = spawnSync('bash', [STOP_HOOK], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, ...defaultEnv(env) },
    timeout: HOOK_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── commit hook: Linear sentinel satisfies the gate ─────────────────────────

test('commit hook: linear-issue-claimed sentinel alone (no Notion sentinel) allows the commit despite Notion being reachable', { skip }, () => {
  const sessionId = randomUUID();
  const claimPath = claimSentinelPath(sessionId);
  writeSentinel(claimPath, 'BRO-2510');
  try {
    const r = runCommitHook({ sessionId });
    assert.equal(r.status, 0, `expected allowed, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
  } finally {
    cleanupSentinels([claimPath]);
  }
});

test('commit hook: linear-issue-reported sentinel alone (no claimed, no Notion sentinel) allows the commit', { skip }, () => {
  const sessionId = randomUUID();
  const reportPath = reportSentinelPath(sessionId);
  writeSentinel(reportPath, 'BRO-2510');
  try {
    const r = runCommitHook({ sessionId });
    assert.equal(r.status, 0, `expected allowed, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
  } finally {
    cleanupSentinels([reportPath]);
  }
});

test('commit hook: both linear sentinels present is also allowed (no special-casing needed)', { skip }, () => {
  const sessionId = randomUUID();
  const claimPath = claimSentinelPath(sessionId);
  const reportPath = reportSentinelPath(sessionId);
  writeSentinel(claimPath, 'BRO-2510');
  writeSentinel(reportPath, 'BRO-2510');
  try {
    const r = runCommitHook({ sessionId });
    assert.equal(r.status, 0, `expected allowed, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
  } finally {
    cleanupSentinels([claimPath, reportPath]);
  }
});

test('commit hook: regression — the original Notion CARD_SENTINEL path is unaffected', { skip }, () => {
  const sessionId = randomUUID();
  const cardPath = cardSentinelPath(sessionId);
  writeSentinel(cardPath, '12345678-1234-1234-1234-123456789012');
  try {
    const r = runCommitHook({ sessionId });
    assert.equal(r.status, 0, `expected allowed, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
  } finally {
    cleanupSentinels([cardPath]);
  }
});

test('commit hook: an EMPTY linear-issue-claimed sentinel does not satisfy the gate — falls through and BLOCKS when Notion is reachable', { skip }, () => {
  const sessionId = randomUUID();
  const claimPath = claimSentinelPath(sessionId);
  writeSentinel(claimPath, ''); // zero-byte — same -s emptiness test as CARD_SENTINEL
  try {
    const r = runCommitHook({ sessionId });
    assert.equal(r.status, 2, `expected BLOCKED (empty sentinel must not satisfy the gate), got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /NO NOTION CARD/);
  } finally {
    cleanupSentinels([claimPath]);
  }
});

test('commit hook: with no sentinel of any kind and a reachable (fake) Notion, the hook still BLOCKS — negative control proving the suite has teeth', { skip }, () => {
  const sessionId = randomUUID();
  const r = runCommitHook({ sessionId });
  assert.equal(r.status, 2, `expected BLOCKED, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
});

test('commit hook: a claimed sentinel skips the reachability probe entirely — returns fast even against a Notion CLI stub that sleeps 8s', { skip }, () => {
  const sessionId = randomUUID();
  const claimPath = claimSentinelPath(sessionId);
  writeSentinel(claimPath, 'BRO-2510');
  try {
    const start = Date.now();
    const r = runCommitHook({ sessionId, env: { BROADWAYSCORE_REPO: SLOW_REPO } });
    const elapsedMs = Date.now() - start;
    assert.equal(r.status, 0, `expected allowed, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
    assert.ok(elapsedMs < 3000, `hook took ${elapsedMs}ms — the linear-sentinel check must short-circuit before the (8s-sleeping) reachability probe, not race it`);
  } finally {
    cleanupSentinels([claimPath]);
  }
});

// ── stop hook: Linear sentinel satisfies the gate ───────────────────────────
//
// Every "allows Stop" test below supplies a transcript with a real tracked
// edit and NO `notion-brain.js update ... --status Done|Paused` call — the
// exact shape that BLOCKS (exit 2) without the fix, per the negative-control
// test at the bottom of this section. A nonexistent transcript would make
// these vacuous (the hook's own pre-existing "no transcript -> pass" branch
// produces the same exit 0 the fix does, for an unrelated reason).

test('stop hook: linear-issue-claimed sentinel allows Stop even with a real tracked-code-edit transcript and no card update', { skip }, () => {
  const sessionId = randomUUID();
  const claimPath = claimSentinelPath(sessionId);
  writeSentinel(claimPath, 'BRO-2510');
  const transcriptPath = makeTrackedEditTranscript('claimed');
  try {
    const r = runStopHook({ sessionId, transcriptPath });
    assert.equal(r.status, 0, `expected allowed, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
  } finally {
    cleanupSentinels([claimPath]);
    fs.rmSync(path.dirname(transcriptPath), { recursive: true, force: true });
  }
});

test('stop hook: linear-issue-reported sentinel alone also allows Stop with a real tracked-code-edit transcript', { skip }, () => {
  const sessionId = randomUUID();
  const reportPath = reportSentinelPath(sessionId);
  writeSentinel(reportPath, 'BRO-2510');
  const transcriptPath = makeTrackedEditTranscript('reported');
  try {
    const r = runStopHook({ sessionId, transcriptPath });
    assert.equal(r.status, 0, `expected allowed, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
  } finally {
    cleanupSentinels([reportPath]);
    fs.rmSync(path.dirname(transcriptPath), { recursive: true, force: true });
  }
});

test('stop hook: an EMPTY linear-issue-claimed sentinel does not satisfy the gate — falls through and BLOCKS on a tracked-edit transcript with no card update', { skip }, () => {
  const sessionId = randomUUID();
  const claimPath = claimSentinelPath(sessionId);
  writeSentinel(claimPath, '');
  const transcriptPath = makeTrackedEditTranscript('empty');
  try {
    const r = runStopHook({ sessionId, transcriptPath });
    assert.equal(r.status, 2, `expected BLOCKED (empty sentinel must not satisfy the gate), got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
    assert.match(r.stderr, /SESSION ENDING WITHOUT NOTION CARD/);
  } finally {
    cleanupSentinels([claimPath]);
    fs.rmSync(path.dirname(transcriptPath), { recursive: true, force: true });
  }
});

test('stop hook: with no sentinel of any kind, a tracked-edit transcript still BLOCKS — negative control proving the suite has teeth', { skip }, () => {
  const sessionId = randomUUID();
  const transcriptPath = makeTrackedEditTranscript('control');
  try {
    const r = runStopHook({ sessionId, transcriptPath });
    assert.equal(r.status, 2, `expected BLOCKED, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
  } finally {
    fs.rmSync(path.dirname(transcriptPath), { recursive: true, force: true });
  }
});

test('stop hook: regression — an unrelated session with no sentinels and no tracked edits (no transcript) still passes through untouched (pre-existing behavior)', { skip }, () => {
  const sessionId = randomUUID();
  const r = runStopHook({ sessionId });
  assert.equal(r.status, 0, `expected allowed, got exit ${r.status}. stderr: ${r.stderr.slice(0, 300)}`);
});
