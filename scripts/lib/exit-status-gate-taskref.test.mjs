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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import os from 'node:os';

const HOOK_PATH = path.join(os.homedir(), '.claude', 'hooks', 'exit-status-gate.sh');

function runGate(lastAssistantMessage) {
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
    const result = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf8' });
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

test('Gate T BLOCKS a final message with "task #1152" and no nearby title', () => {
  const { status, stderr } = runGate(NO_TITLE_MSG);
  assert.equal(status, 2, `expected block (exit 2), got ${status}\nstderr:\n${stderr}`);
  assert.match(stderr, /task\/card by bare number/i);
});

test('Gate T PASSES the same message once a quoted title is added on that line', () => {
  const { status, stderr } = runGate(TITLED_MSG);
  assert.equal(status, 0, `expected pass (exit 0), got ${status}\nstderr:\n${stderr}`);
});

test('Gate T ignores ordinal prose ("Step #3") with no task keyword', () => {
  const { status } = runGate('Here is the plan: Step #3 handles the schema migration.');
  assert.equal(status, 0);
});

test('Gate T ignores enumeration refs ("issue #1 of 5")', () => {
  const { status } = runGate('Progress note: issue #1 of 5 sub-tasks is done.');
  assert.equal(status, 0);
});

test('Gate T exempts EXECUTED: lines (they quote a literal verification command)', () => {
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
