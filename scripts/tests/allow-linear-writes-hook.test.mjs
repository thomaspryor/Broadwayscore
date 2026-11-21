// BRO-7534: the Linear connector's comment and issue writes must run without a prompt whatever the
// server is called, and nothing else may be allowed by accident. Runs the real hook script.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude', 'hooks', 'allow-linear-writes.sh');
const UUID = '0b2f7a3c-1d4e-4f56-8a9b-123456789abc';

function decide(tool, env = {}, toolInput = {}) {
  const r = spawnSyncStdinFile('bash', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, HOME: '/nonexistent-home', CLAUDE_CODE_REMOTE: '', ...env },
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

test('kill switch turns it off', () => {
  assert.equal(decide('mcp__Linear__save_comment', { ALLOW_LINEAR_WRITES_DISABLE: '1' }), null);
});

test('a copy of the hook under $HOME/.claude/hooks defers to that copy', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'alw-home-'));
  mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
  writeFileSync(path.join(home, '.claude', 'hooks', 'allow-linear-writes.sh'), '');
  assert.equal(decide('mcp__Linear__save_comment', { HOME: home }), null);
});

test('closing a card directly (state Done/Canceled) keeps its prompt; other issue writes are allowed', () => {
  for (const state of ['Done', 'done', 'Canceled', 'Duplicate']) assert.equal(decide('mcp__Linear__save_issue', {}, { state }), null, state);
  for (const state of ['In Progress', 'Backlog', 'Todo']) assert.equal(decide('mcp__Linear__save_issue', {}, { state }).permissionDecision, 'allow', state);
  assert.equal(decide('mcp__Linear__save_comment', {}, { body: 'x' }).permissionDecision, 'allow');
});

test('settings.json wires the hook for all three connector prefixes', () => {
  const s = JSON.parse(readFileSync(path.join(path.dirname(HOOK), '..', 'settings.json'), 'utf8'));
  const g = s.hooks.PreToolUse.find((x) => x.hooks.some((h) => h.command.includes('allow-linear-writes.sh')));
  assert.ok(g, 'PreToolUse group for allow-linear-writes.sh');
  const re = new RegExp(`^(?:${g.matcher})$`);
  for (const server of ['Linear', 'claude_ai_Linear', UUID]) for (const t of ['save_comment', 'save_issue']) assert.ok(re.test(`mcp__${server}__${t}`), `${server} ${t}`);
});

test('unparseable input fails open with no decision', () => {
  const r = spawnSyncStdinFile('bash', [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent-home' } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});

test('in cloud, a NEW comment or issue is redirected to linear-brain.js (deny); updates and non-cloud stay allowed', () => {
  const cloud = { CLAUDE_CODE_REMOTE: 'true' };
  const c = decide(`mcp__${UUID}__save_comment`, cloud, { issue: 'BRO-1', body: 'x' });
  assert.equal(c.permissionDecision, 'deny');
  assert.match(c.permissionDecisionReason, /linear-brain\.js" update BRO-N --comment/);
  const i = decide('mcp__Linear__save_issue', cloud, { title: 't', team: 'BRO' });
  assert.equal(i.permissionDecision, 'deny');
  assert.match(i.permissionDecisionReason, /linear-brain\.js" create/);
  assert.equal(decide('mcp__Linear__save_comment', cloud, { id: 'abc', body: 'edit' }).permissionDecision, 'allow');
  assert.equal(decide('mcp__Linear__save_issue', cloud, { id: 'BRO-1', priority: 1 }).permissionDecision, 'allow');
  assert.equal(decide('mcp__Linear__save_comment', {}, { issue: 'BRO-1', body: 'x' }).permissionDecision, 'allow');
  assert.equal(decide('mcp__Linear__save_comment', { ...cloud, ALLOW_LINEAR_WRITES_NO_REDIRECT: '1' }, { issue: 'BRO-1', body: 'x' }).permissionDecision, 'allow');
  assert.equal(decide('mcp__Linear__save_issue', cloud, { state: 'Done' }), null);
});

test('in cloud, a create the script cannot do (parentId, labels) is not redirected; the steering text is safe to paste', () => {
  const cloud = { CLAUDE_CODE_REMOTE: 'true' };
  assert.equal(decide('mcp__Linear__save_comment', cloud, { issue: 'BRO-1', body: 'x', parentId: 'p' }).permissionDecision, 'allow');
  assert.equal(decide('mcp__Linear__save_issue', cloud, { title: 't', team: 'BRO', labels: ['a'] }).permissionDecision, 'allow');
  assert.match(decide('mcp__Linear__save_comment', cloud, { issue: 'BRO-1', body: 'x' }).permissionDecisionReason, /cat <<'EOF'/);
});
