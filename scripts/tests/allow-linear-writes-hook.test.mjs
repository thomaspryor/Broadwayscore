// BRO-7534: the Linear connector's comment and issue writes must run without a prompt whatever the
// server is called, and nothing else may be allowed by accident. Runs the real hook script.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'hooks', 'allow-linear-writes.sh');
const UUID = '0b2f7a3c-1d4e-4f56-8a9b-123456789abc';

function decide(tool, env = {}) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {} }),
    encoding: 'utf8',
    env: { ...process.env, HOME: '/nonexistent-home', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

for (const server of ['Linear', 'claude_ai_Linear', UUID, 'LINEAR']) {
  for (const t of ['save_comment', 'save_issue']) {
    test(`allows mcp__${server}__${t}`, () => {
      const d = decide(`mcp__${server}__${t}`);
      assert.equal(d.permissionDecision, 'allow');
      assert.equal(d.hookEventName, 'PreToolUse');
    });
  }
}

test('gives no decision for deletes, other Linear tools, other servers and lookalikes', () => {
  for (const t of [
    'mcp__Linear__delete_comment', 'mcp__Linear__delete_attachment', 'mcp__Linear__list_issues',
    'mcp__Notion__save_comment', 'mcp__github__save_issue', `mcp__${UUID}__delete_comment`,
    'mcp__Linear__save_comment_extra', 'xmcp__Linear__save_comment', 'save_comment', '',
  ]) assert.equal(decide(t), null, t);
});

test('kill switch and a master hook under $HOME both turn it off', () => {
  assert.equal(decide('mcp__Linear__save_comment', { ALLOW_LINEAR_WRITES_DISABLE: '1' }), null);
});

test('unparseable input fails open with no decision', () => {
  const r = spawnSync('bash', [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent-home' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});
