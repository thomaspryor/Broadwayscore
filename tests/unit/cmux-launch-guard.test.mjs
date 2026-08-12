/**
 * Guard: cmux new-workspace launches of "claude" must carry
 * --dangerously-skip-permissions (task #1306, 2026-08-12 incident — a
 * hand-rolled `cmux new-workspace --command "claude --model X <seed>"`
 * omitted the flag, causing permission-prompt stalls and 2 cross-session
 * messages that expired undelivered).
 *
 * Requires the real function per CLAUDE.md rule 15 — no copied logic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  evaluateCmuxLaunch,
  BYPASS_TOKEN,
  firstTokenBasename,
  splitSegments,
} from '../../scripts/lib/cmux-launch-guard.js';

describe('cmux-launch-guard: evaluateCmuxLaunch', () => {
  test('blocks the exact incident command (no flag)', () => {
    const cmd = 'cmux new-workspace --name x --cwd ~/Broadwayscore --command "claude --model claude-fable-5 seed text" --focus true';
    const r = evaluateCmuxLaunch(cmd);
    assert.strictEqual(r.block, true);
    assert.match(r.reason, /--dangerously-skip-permissions/);
    assert.match(r.reason, /bsc-next\.js:1007/);
  });

  test('allows the same command with the flag present', () => {
    const cmd = 'cmux new-workspace --command "claude --model claude-fable-5 --dangerously-skip-permissions seed text" --focus true';
    const r = evaluateCmuxLaunch(cmd);
    assert.strictEqual(r.block, false);
  });

  test('blocks single-quoted --command value', () => {
    const cmd = "cmux new-workspace --command 'claude --model sonnet seed' --focus true";
    const r = evaluateCmuxLaunch(cmd);
    assert.strictEqual(r.block, true);
  });

  test('allows when --command is absent (plain terminal / workspace-action)', () => {
    assert.strictEqual(evaluateCmuxLaunch('cmux ~/Broadwayscore').block, false);
    assert.strictEqual(
      evaluateCmuxLaunch('cmux workspace-action --action rename --title "🤖⚡ Infra·foo"').block,
      false
    );
  });

  test('allows non-claude launchers (codex/opencode/omo/claude-teams)', () => {
    for (const bin of ['codex', 'opencode', 'omo', 'claude-teams', 'claude-code-guide']) {
      const cmd = `cmux new-workspace --command "${bin} --model sonnet seed" --focus true`;
      assert.strictEqual(evaluateCmuxLaunch(cmd).block, false, `expected ${bin} to be allowed`);
    }
  });

  test('allows non-interactive claude subcommands (no --model)', () => {
    for (const inner of ['claude doctor', 'claude mcp serve', 'claude --version', 'claude --print "x"']) {
      const cmd = `cmux new-workspace --command "${inner}" --focus true`;
      assert.strictEqual(evaluateCmuxLaunch(cmd).block, false, `expected "${inner}" to be allowed`);
    }
  });

  test('bypass token skips the check', () => {
    const cmd = 'CMUX_LAUNCH_UNSAFE_OK=1 cmux new-workspace --command "claude --model sonnet seed" --focus true';
    const r = evaluateCmuxLaunch(cmd);
    assert.strictEqual(r.block, false);
    assert.strictEqual(r.bypassed, true);
  });

  test('env-var-prefixed claude invocation without the flag still blocks', () => {
    const cmd = 'cmux new-workspace --command "ANTHROPIC_API_KEY=x claude --model sonnet seed" --focus true';
    assert.strictEqual(evaluateCmuxLaunch(cmd).block, true);
  });

  test('recurses one level into a bash-wrapper file missing the flag', () => {
    const files = {
      '/tmp/bsc-cmd-123.sh': '#!/bin/bash\nclaude --model sonnet "$(cat /tmp/seed.txt)"\n',
    };
    const cmd = 'cmux new-workspace --command " bash /tmp/bsc-cmd-123.sh" --focus true';
    const r = evaluateCmuxLaunch(cmd, { readFile: (p) => files[p] || null });
    assert.strictEqual(r.block, true);
  });

  test('bash-wrapper file WITH the flag is allowed (matches the canonical launcher shape)', () => {
    const files = {
      '/tmp/bsc-cmd-123.sh': '#!/bin/bash\nclaude --model sonnet --dangerously-skip-permissions "$(cat /tmp/seed.txt)"\n',
    };
    const cmd = 'cmux new-workspace --command " bash /tmp/bsc-cmd-123.sh" --focus true';
    const r = evaluateCmuxLaunch(cmd, { readFile: (p) => files[p] || null });
    assert.strictEqual(r.block, false);
  });

  test('missing/unreadable wrapper file fails open (no block)', () => {
    const cmd = 'cmux new-workspace --command " bash /tmp/does-not-exist.sh" --focus true';
    const r = evaluateCmuxLaunch(cmd, { readFile: () => null });
    assert.strictEqual(r.block, false);
  });

  test('BYPASS_TOKEN constant matches documented escape hatch', () => {
    assert.strictEqual(BYPASS_TOKEN, 'CMUX_LAUNCH_UNSAFE_OK=1');
  });
});

describe('cmux-launch-guard: helpers', () => {
  test('firstTokenBasename resolves a path token to its basename', () => {
    assert.strictEqual(firstTokenBasename('/usr/local/bin/claude --model sonnet'), 'claude');
  });

  test('firstTokenBasename does not treat claude-teams as claude', () => {
    assert.strictEqual(firstTokenBasename('claude-teams start'), 'claude-teams');
  });

  test('splitSegments splits on ; && || | and newline', () => {
    assert.deepStrictEqual(
      splitSegments('a; b && c || d | e\nf').map((s) => s.trim()),
      ['a', 'b', 'c', 'd', 'e', 'f']
    );
  });
});
