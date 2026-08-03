import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  findClaudeCodePid,
  isFlaglessClaudeCommand,
  composeReviveCommand,
  detectFlaglessSession,
  reviveSession,
} = require('./revive-session.js');

// Real `cmux top --workspace X --processes --format tsv` sample (captured
// live, 2026-08-03) — the claude_code process row's `id` column (14046) is
// the OS pid; confirmed against `ps -p 14046` on the same host.
const REAL_TOP_TSV = [
  '9.4\t1241546752\t16\ttotal\ttotal\t\t',
  '9.4\t1241546752\t16\twindow\twindow:1\ttotal\t',
  '9.4\t1241546752\t16\tworkspace\tworkspace:1\twindow:1\t✳ Write AI musical comedy',
  '0.3\t178028544\t3\ttag\tworkspace:79E4:tag:claude_code\tworkspace:1\t',
  '0.3\t164790272\t1\tprocess\t14046\tworkspace:79E4:tag:claude_code\t2.1.220',
  '0.0\t8650752\t1\tprocess\t14264\t14046\tnode',
].join('\n');

test('findClaudeCodePid: extracts the pid from the claude_code process row', () => {
  assert.equal(findClaudeCodePid(REAL_TOP_TSV), 14046);
});

test('findClaudeCodePid: null when no claude_code process row exists', () => {
  assert.equal(findClaudeCodePid('9.4\t1\t1\tworkspace\tworkspace:1\twindow:1\t'), null);
});

test('findClaudeCodePid: null on empty/garbage input', () => {
  assert.equal(findClaudeCodePid(''), null);
  assert.equal(findClaudeCodePid('not tsv at all'), null);
});

// Evidence from the card: the actual flagless revive command cmux composed.
const FLAGLESS_RESUME = 'claude --worktree gap-audit-checkpoint-lock-warning --resume 8ddb3d0d-7b41-484d-ab0e-574efce80c68';
const FLAGGED_LAUNCH = 'claude --model sonnet --dangerously-skip-permissions "$(cat /tmp/bsc-seed-985.txt)"';

test('isFlaglessClaudeCommand: flags a real flagless resume line', () => {
  assert.equal(isFlaglessClaudeCommand(FLAGLESS_RESUME), true);
});

test('isFlaglessClaudeCommand: passes a properly flagged launch line', () => {
  assert.equal(isFlaglessClaudeCommand(FLAGGED_LAUNCH), false);
});

test('isFlaglessClaudeCommand: false for a non-claude command (nothing to flag)', () => {
  assert.equal(isFlaglessClaudeCommand('node scripts/bsc-next.js --id 985'), false);
  assert.equal(isFlaglessClaudeCommand(''), false);
  assert.equal(isFlaglessClaudeCommand(null), false);
});

test('composeReviveCommand: composed command contains --dangerously-skip-permissions', () => {
  const composed = composeReviveCommand(FLAGLESS_RESUME, { model: 'sonnet' });
  assert.match(composed, /--dangerously-skip-permissions/);
});

test('composeReviveCommand: preserves the original --worktree/--resume args', () => {
  const composed = composeReviveCommand(FLAGLESS_RESUME, { model: 'sonnet' });
  assert.match(composed, /--worktree gap-audit-checkpoint-lock-warning/);
  assert.match(composed, /--resume 8ddb3d0d-7b41-484d-ab0e-574efce80c68/);
});

test('composeReviveCommand: injects --model only when the original lacks one', () => {
  const composed = composeReviveCommand(FLAGLESS_RESUME, { model: 'opus' });
  assert.match(composed, /--model opus/);

  const alreadyHasModel = 'claude --model haiku --resume abc-123';
  const composed2 = composeReviveCommand(alreadyHasModel, { model: 'opus' });
  assert.doesNotMatch(composed2, /--model opus/);
  assert.match(composed2, /--model haiku/);
});

test('composeReviveCommand: already-flagged command is left alone (still contains the flag once)', () => {
  const composed = composeReviveCommand(FLAGGED_LAUNCH, { model: 'sonnet' });
  const matches = composed.match(/--dangerously-skip-permissions/g) || [];
  assert.equal(matches.length, 1);
});

test('detectFlaglessSession: flags a workspace whose live process is flagless', () => {
  const result = detectFlaglessSession('workspace:116', {
    topTsvFn: () => REAL_TOP_TSV,
    psCommandFn: (pid) => { assert.equal(pid, 14046); return FLAGLESS_RESUME + '\n'; },
  });
  assert.equal(result.flagless, true);
  assert.equal(result.pid, 14046);
});

test('detectFlaglessSession: passes a workspace whose live process already has the flag', () => {
  const result = detectFlaglessSession('workspace:116', {
    topTsvFn: () => REAL_TOP_TSV,
    psCommandFn: () => FLAGGED_LAUNCH + '\n',
  });
  assert.equal(result.flagless, false);
});

test('detectFlaglessSession: fails safe to not-flagless when no claude process is found', () => {
  const result = detectFlaglessSession('workspace:999', {
    topTsvFn: () => '9.4\t1\t1\tworkspace\tworkspace:999\twindow:1\t',
    psCommandFn: () => { throw new Error('should not be called'); },
  });
  assert.equal(result.flagless, false);
  assert.equal(result.pid, null);
});

test('detectFlaglessSession: fails safe when the cmux/ps call throws', () => {
  const result = detectFlaglessSession('workspace:1', {
    topTsvFn: () => { throw new Error('socket error'); },
    psCommandFn: () => { throw new Error('should not be called'); },
  });
  assert.equal(result.flagless, false);
});

test('reviveSession: respawns a flagless workspace with the flag restored', () => {
  let respawnedWith = null;
  const result = reviveSession('workspace:116', {
    model: 'sonnet',
    deps: {
      detectFn: () => ({ flagless: true, pid: 14046, command: FLAGLESS_RESUME }),
      readLedgerEntriesFn: () => [],
      launchByRefFn: () => null,
      respawnFn: (ref, command) => { respawnedWith = { ref, command }; },
    },
  });
  assert.equal(result.revived, true);
  assert.equal(respawnedWith.ref, 'workspace:116');
  assert.match(respawnedWith.command, /--dangerously-skip-permissions/);
});

test('reviveSession: no-op when the session already has the flag', () => {
  let called = false;
  const result = reviveSession('workspace:116', {
    deps: {
      detectFn: () => ({ flagless: false, pid: 14046, command: FLAGGED_LAUNCH }),
      respawnFn: () => { called = true; },
    },
  });
  assert.equal(result.revived, false);
  assert.equal(called, false);
});

test('reviveSession: no-op when no claude process was found (nothing to revive)', () => {
  let called = false;
  const result = reviveSession('workspace:999', {
    deps: {
      detectFn: () => ({ flagless: false, pid: null, command: null }),
      respawnFn: () => { called = true; },
    },
  });
  assert.equal(result.revived, false);
  assert.equal(result.reason, 'no-claude-process-found');
  assert.equal(called, false);
});

test('reviveSession: falls back to the ledger model when no explicit model is passed', () => {
  let respawnedWith = null;
  const result = reviveSession('workspace:116', {
    deps: {
      detectFn: () => ({ flagless: true, pid: 14046, command: FLAGLESS_RESUME }),
      readLedgerEntriesFn: () => [{ event: 'launch', workspaceRef: 'workspace:116', model: 'opus' }],
      launchByRefFn: (ref, entries) => entries.find(e => e.workspaceRef === ref) || null,
      respawnFn: (ref, command) => { respawnedWith = { ref, command }; },
    },
  });
  assert.equal(result.revived, true);
  assert.match(respawnedWith.command, /--model opus/);
});
