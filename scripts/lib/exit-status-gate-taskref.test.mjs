// scripts/lib/exit-status-gate-taskref.test.mjs
//
// Acceptance test for card #1153 (owner escalation 2026-08-09, second
// escalation on this ID class after workspaces/2026-07-31): the exit-status
// Stop hook (~/.claude/hooks/exit-status-gate.sh) already blocks a bare
// "workspace:150" reference unless a quoted title sits nearby (Gate W). It
// did nothing for "task #1152" / "card #1152" / "issue #1152" / bare
// "#1152" — a DIFFERENT numeric namespace the owner's Notion board can't
// resolve any better than the cmux sidebar can resolve a bare workspace
// number. Gate T closes that gap.
//
// This hook lives outside the repo at ~/.claude/hooks/ (shared across every
// project on the machine, not just Broadwayscore — CLAUDE.md rule 18), so
// there is no pure function to require() the way CLAUDE.md rule 15 prefers.
// Instead this spawns the REAL hook script with a crafted Stop-event stdin
// payload, the same integration-test shape run.sh already uses for this
// hook family at ~/.claude/hooks/tests/exit-status-gate/ (see that directory
// for the canonical fixture-based suite this test complements, not
// replaces).
//
// HOOK_PATH deliberately uses os.userInfo().homedir, NOT os.homedir(): this
// project's own close-time verify (scripts/lib/autonomous-checks.js
// checksEnv()) re-runs a card's acceptance command with $HOME pointed at a
// throwaway temp dir (secret-free sandbox) — os.homedir() follows that fake
// $HOME and silently can't find the real hook, failing every case here.
// os.userInfo().homedir reads the real account home via getpwuid regardless
// of $HOME, so this test resolves the same hook whether run by a developer
// or by that sandboxed re-verify (confirmed: HOME=/tmp override changes
// os.homedir() but not os.userInfo().homedir).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';

const REAL_HOME = os.userInfo().homedir;
const HOOK_PATH = path.join(REAL_HOME, '.claude', 'hooks', 'exit-status-gate.sh');
// The hook's own python3 subprocess ALSO resolves its lib/ imports via
// os.path.expanduser('~'), which follows $HOME — so a sandboxed caller
// (checksEnv() above) must have the REAL HOME threaded through the whole
// bash→python3 chain, not just used to locate this script.
const HOOK_ENV = { ...process.env, HOME: REAL_HOME };

// The hook lives in the owner's PRIVATE ~/.claude repo, which a CI runner does
// not check out — spawnSync('bash', [missing path]) exits 127, and every case
// below read that as "the gate failed to block", turning main red for a reason
// that has nothing to do with the repo (observed on run 31400031919, 6 failures,
// all `expected block (exit 2), got 127`). This file sits in scripts/lib/, which
// test.yml auto-globs, so it runs in CI whether or not it can possibly pass.
// Skip honestly when the hook is absent rather than assert against a missing
// binary: a skipped test says "not verifiable here", a failing one lies about
// the gate being broken.
const HOOK_PRESENT = existsSync(HOOK_PATH);
const skipIfNoHook = HOOK_PRESENT
  ? false
  : `exit-status-gate.sh not present at ${HOOK_PATH} — hooks live in the private ~/.claude repo, absent on CI runners`;

function runGate(lastAssistantMessage, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'esg-taskref-'));
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  // A minimal real user turn — enough for the hook's transcript walker to
  // establish turn boundaries; Gate T's scan runs unconditionally (like
  // Gate W), so no tool_use/edit is required to exercise it.
  writeFileSync(transcriptPath, JSON.stringify({
    type: 'user', isSidechain: false,
    message: { role: 'user', content: 'dispatch the fix' },
  }) + '\n');
  const input = JSON.stringify({
    transcript_path: transcriptPath,
    stop_hook_active: false,
    last_assistant_message: lastAssistantMessage,
  });
  try {
    const result = spawnSync('bash', [HOOK_PATH], {
      input, encoding: 'utf8', env: { ...HOOK_ENV, ...extraEnv },
    });
    return { status: result.status, stderr: result.stderr || '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NO_TITLE_MSG = [
  'Wrapped up.',
  '',
  'DISPATCHED: workspace:257 ("Data·Some Title") — dispatched task #1152, see #1144',
  '',
  'THIS SESSION: CLOSE ME — everything verified; follow-up continues in workspace:257 ("Data·Some Title")',
].join('\n');

const TITLED_MSG = [
  'Wrapped up.',
  '',
  'DISPATCHED: workspace:257 ("Data·Some Title") — dispatched task #1152 ("P0: exit-status-gate Gate W misses TASK/CARD numbers"), see #1144 ("A DEAD dispatch marks its own task completed")',
  '',
  'THIS SESSION: CLOSE ME — everything verified; follow-up continues in workspace:257 ("Data·Some Title")',
].join('\n');

test('Gate T BLOCKS a final message with "task #1152" and no nearby title', { skip: skipIfNoHook }, () => {
  const { status, stderr } = runGate(NO_TITLE_MSG);
  assert.equal(status, 2, `expected block (exit 2), got ${status}\nstderr:\n${stderr}`);
  assert.match(stderr, /task\/card by bare number/i);
});

test('Gate T PASSES the same message once a quoted title is added on that line', { skip: skipIfNoHook }, () => {
  const { status, stderr } = runGate(TITLED_MSG);
  assert.equal(status, 0, `expected pass (exit 0), got ${status}\nstderr:\n${stderr}`);
});

test('Gate T ignores ordinal prose ("Step #3") with no task keyword', { skip: skipIfNoHook }, () => {
  const { status } = runGate('Here is the plan: Step #3 handles the schema migration.');
  assert.equal(status, 0);
});

test('Gate T ignores enumeration refs ("issue #1 of 5")', { skip: skipIfNoHook }, () => {
  const { status } = runGate('Progress note: issue #1 of 5 sub-tasks is done.');
  assert.equal(status, 0);
});

test('Gate T exempts EXECUTED: lines (they quote a literal verification command)', { skip: skipIfNoHook }, () => {
  const msg = [
    'Fixed and verified.',
    '',
    'EXECUTED: gh issue view #1152 — confirmed it’s still open',
    '',
    'THIS SESSION: CLOSE ME — fix shipped and verified on main',
  ].join('\n');
  const { status } = runGate(msg);
  assert.equal(status, 0);
});

test('Gate T surfaces a title for a task that only exists under archive/ (task-store-archive.js layout)', { skip: skipIfNoHook }, () => {
  // task-store-archive.js moves (not copies) tasks completed >24h ago out of
  // ~/.claude/tasks/<slug>/<id>.json into a sibling archive/<id>.json — the
  // hook's title-hint lookup must check both, or every reference to an
  // older completed task silently loses its hint.
  const dir = mkdtempSync(path.join(tmpdir(), 'esg-taskref-archive-'));
  const archiveDir = path.join(dir, 'archive');
  try {
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(path.join(archiveDir, '9991.json'), JSON.stringify({
      id: '9991', subject: 'Archived task title for gate T lookup test',
    }));
    const { status, stderr } = runGate(
      'Follow-up needed on #9991 before closing.', { ESG_TASKS_DIR: dir });
    assert.equal(status, 2);
    assert.match(stderr, /Archived task title for gate T lookup test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
