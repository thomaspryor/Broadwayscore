// scripts/tests/dispatch-claim-requires-workspace.test.mjs
//
// Acceptance test for task #1691 (owner incident 2026-08-16): a session
// created 4 real work-item cards via
// `notion-brain.js create --dispatch --no-spawn` (which skips launching a
// bsc-next workspace) and still reported "DISPATCHED:" for all four — they
// sat permanently claimed in the shared task list (Notion Status "In
// progress" -> task-mirror `in_progress`), invisible to `bsc-next --list`,
// with nobody working them. Two independent layers now close this:
//
//   1. notion-tasks-sync.js's isMirrorableCard() excludes any card carrying
//      the NO-DISPATCH marker (written by notion-brain.js when --no-spawn is
//      used) from the task mirror entirely — it can never occupy a claimed
//      slot, whatever its Notion Status. require()s the REAL
//      isMirrorableCard/mapStatus (CLAUDE.md rule 15) — nothing here restates
//      the mapping.
//   2. ~/.claude/hooks/exit-status-gate.sh's Gate P blocks a session's final
//      message when it contains a `DISPATCHED:` line whose quoted title has
//      no matching LIVE cmux workspace — the mechanical backstop for a false
//      claim written by hand, not just one from notion-brain.js. Spawns the
//      REAL hook, following the pattern in
//      scripts/lib/exit-status-gate-taskref.test.mjs (Gate T's own test) —
//      the hook lives outside this repo at ~/.claude/hooks/, so there is no
//      pure function to require() the way rule 15 prefers for gate 2.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const require = createRequire(import.meta.url);

// ── Part 1: isMirrorableCard excludes NO-DISPATCH-marked cards ─────────────

const { isMirrorableCard, mapStatus } = require(path.join(REPO_ROOT, 'scripts', 'notion-tasks-sync.js'));

test('a NO-DISPATCH-marked card is excluded from the task mirror, even with Status "In progress"', () => {
  const card = {
    id: 'fake-page-id',
    name: 'P1: some real work item wrongly created with --no-spawn',
    status: 'In progress',
    notes: 'NO-DISPATCH: standing owner-review-status card, never auto-dispatched by bsc-next\n\nsome other notes',
  };
  // Prove what WOULD happen without the exclusion: mapStatus alone maps
  // "In progress" straight to the claimed state this bug is about.
  assert.equal(mapStatus(card.status), 'in_progress');
  // The real fix: isMirrorableCard() must refuse this card before it ever
  // reaches mapStatus() inside planPull() — no mirror entry, no claimed slot.
  assert.equal(isMirrorableCard(card), false);
});

test('a card with no NO-DISPATCH marker is still mirrorable (no false-positive exclusion)', () => {
  const card = {
    id: 'fake-page-id-2',
    name: 'P1: a normal work item',
    status: 'In progress',
    notes: 'Just a normal card with no special marker.',
  };
  assert.equal(isMirrorableCard(card), true);
});

// ── Part 2: Gate P blocks an unbacked DISPATCHED: claim ─────────────────────

const REAL_HOME = os.userInfo().homedir;
const HOOK_PATH = path.join(REAL_HOME, '.claude', 'hooks', 'exit-status-gate.sh');
const HOOK_ENV = { ...process.env, HOME: REAL_HOME };
const HOOK_PRESENT = existsSync(HOOK_PATH);
const skipIfNoHook = HOOK_PRESENT
  ? false
  : `exit-status-gate.sh not present at ${HOOK_PATH} — hooks live in the private ~/.claude repo, absent on CI runners`;

// A fake `cmux` binary: `list-workspaces` prints one controllable line, every
// other subcommand is a harmless no-op. Gate P (and Gate W, incidentally)
// only ever calls `list-workspaces` in this test.
function makeFakeCmux(dir, workspaceTitle) {
  const cmuxPath = path.join(dir, 'cmux');
  writeFileSync(cmuxPath, [
    '#!/usr/bin/env bash',
    'if [ "$1" = "list-workspaces" ]; then',
    `  echo '  workspace:9001  ${workspaceTitle}'`,
    'fi',
    'exit 0',
  ].join('\n'));
  chmodSync(cmuxPath, 0o755);
  return cmuxPath;
}

// A fake `cmux` whose `list-workspaces` returns ZERO workspaces (reachable,
// genuinely empty) — the most extreme case Gate P must catch (ship-check
// P0 catch, Codex: an earlier version of this gate silently PASSED here,
// because an empty title list reached the checker's own usage-error exit,
// which Gate P (correctly, for a real checker crash) treats as unresolvable
// and skips).
function makeFakeCmuxEmpty(dir) {
  const cmuxPath = path.join(dir, 'cmux');
  writeFileSync(cmuxPath, [
    '#!/usr/bin/env bash',
    'exit 0',
  ].join('\n'));
  chmodSync(cmuxPath, 0o755);
  return cmuxPath;
}

// Gate P resolves scripts/lib/title-overlap-check.mjs by walking `cwd` up to
// its git-common-dir's repo root (same as ESG_REPO_NAME) — there is no env
// override, so a test must hand the hook a real, resolvable `cwd` rather
// than trying to inject ESG_REPO_ROOT directly (the hook unconditionally
// recomputes it from `cwd` on every invocation). For a worktree checkout
// specifically, git-common-dir resolves to the MAIN repo, not the worktree
// — so pointing `cwd` at this worktree would look for the checker script in
// the main repo, where an unmerged worktree branch's new files don't exist
// yet. Building a throwaway one-file git repo containing just the checker +
// its one dependency sidesteps both problems and needs no repo state at all.
function makeCheckerFixtureRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'esg-dispatch-repo-'));
  const libDir = path.join(dir, 'scripts', 'lib');
  mkdirSync(libDir, { recursive: true });
  // dispatch-ledger.js's own local requires — a fixture missing either one
  // makes the checker script's require() throw, which must degrade Gate P
  // to skip (not a false MATCH/NOMATCH) — exercised by construction here
  // since a real checkout always has all three together.
  for (const f of ['title-overlap-check.mjs', 'dispatch-ledger.js', 'dispatch-attempts.js', 'workspace-naming.js']) {
    copyFileSync(path.join(REPO_ROOT, 'scripts', 'lib', f), path.join(libDir, f));
  }
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}
const CHECKER_REPO = makeCheckerFixtureRepo();

function runGate(lastAssistantMessage, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'esg-dispatch-'));
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, JSON.stringify({
    type: 'user', isSidechain: false,
    message: { role: 'user', content: 'dispatch the fix' },
  }) + '\n');
  const input = JSON.stringify({
    transcript_path: transcriptPath,
    stop_hook_active: false,
    last_assistant_message: lastAssistantMessage,
    cwd: CHECKER_REPO,
  });
  try {
    const result = spawnSync('bash', [HOOK_PATH], {
      input, encoding: 'utf8',
      env: { ...HOOK_ENV, ...extraEnv },
    });
    return { status: result.status, stderr: result.stderr || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Gate P BLOCKS a DISPATCHED: line whose quoted title matches no live cmux workspace', { skip: skipIfNoHook }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'esg-dispatch-cmux-'));
  try {
    const cmuxBin = makeFakeCmux(dir, '🤖⚡ Data·A completely unrelated workspace title here');
    const msg = [
      'Wrapped up.',
      '',
      'DISPATCHED: task #9999 ("P1: some real work item wrongly created with --no-spawn")',
      '',
      'THIS SESSION: CLOSE ME — dispatched, follow-up continues elsewhere',
    ].join('\n');
    const { status, stderr } = runGate(msg, { CMUX_BIN: cmuxBin });
    assert.equal(status, 2, `expected block (exit 2), got ${status}\nstderr:\n${stderr}`);
    assert.match(stderr, /no live cmux workspace title matches/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate P PASSES the same claim once a live workspace title actually overlaps it', { skip: skipIfNoHook }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'esg-dispatch-cmux-ok-'));
  try {
    const claimedTitle = 'P1: some real work item wrongly created with --no-spawn';
    const cmuxBin = makeFakeCmux(dir, `🤖⚡ Data·${claimedTitle}`);
    const msg = [
      'Wrapped up.',
      '',
      `DISPATCHED: task #9999 ("${claimedTitle}")`,
      '',
      'THIS SESSION: CLOSE ME — dispatched, follow-up continues elsewhere',
    ].join('\n');
    const { status, stderr } = runGate(msg, { CMUX_BIN: cmuxBin });
    assert.equal(status, 0, `expected pass (exit 0), got ${status}\nstderr:\n${stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate P ignores DEFERRED: lines (they never claim a workspace launched)', { skip: skipIfNoHook }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'esg-dispatch-deferred-'));
  try {
    const cmuxBin = makeFakeCmux(dir, '🤖⚡ Data·Something else entirely');
    const msg = [
      'DEFERRED: task #9999 ("P1: needs an owner call") — no automatic path',
      '',
      'THIS SESSION: IDLE — nothing running, parked for the owner',
    ].join('\n');
    const { status } = runGate(msg, { CMUX_BIN: cmuxBin });
    assert.equal(status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate P BLOCKS a DISPATCHED: claim when cmux is reachable but reports ZERO live workspaces (the most extreme case — Codex ship-check catch)', { skip: skipIfNoHook }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'esg-dispatch-cmux-empty-'));
  try {
    const cmuxBin = makeFakeCmuxEmpty(dir);
    const msg = [
      'Wrapped up.',
      '',
      'DISPATCHED: task #9999 ("P1: some real work item wrongly created with --no-spawn")',
      '',
      'THIS SESSION: CLOSE ME — dispatched, follow-up continues elsewhere',
    ].join('\n');
    const { status, stderr } = runGate(msg, { CMUX_BIN: cmuxBin });
    assert.equal(status, 2, `expected block (exit 2), got ${status}\nstderr:\n${stderr}`);
    assert.match(stderr, /no live cmux workspace title matches/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
