// BRO-4745: Codex must run under the same guards, checklists and reach as Claude.
// These tests fail when the Codex side drifts from the Claude side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const adapter = require('../../scripts/codex/hook-adapter.js');
const { diffSkills, renderSkills } = require('../../scripts/codex/sync-skills.js');
const { mergeToml, mergeHooks } = require('../../scripts/codex/install.js');
const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
const codexHooks = JSON.parse(readFileSync(join(ROOT, '.codex', 'hooks.json'), 'utf8'));

// Codex 0.160 hook events (learn.chatgpt.com/docs/hooks).
const CODEX_EVENTS = new Set(['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'Stop', 'Interrupt']);

test('every Claude hook event Codex supports is routed to the adapter', () => {
  for (const event of Object.keys(settings.hooks || {})) {
    if (!CODEX_EVENTS.has(event)) continue;
    const groups = codexHooks.hooks[event] || [];
    const routed = groups.some((g) => (g.hooks || []).some((h) => h.command.includes('scripts/codex/hook-adapter.js') && h.command.includes(`--event ${event}`)));
    assert.ok(routed, `.codex/hooks.json has no adapter entry for ${event}`);
  }
});

test('committed .agents/skills match the Claude sources (run scripts/codex/sync-skills.js)', () => {
  const { stale, extra } = diffSkills(ROOT);
  assert.deepEqual({ stale, extra }, { stale: [], extra: [] });
  const names = [...renderSkills(ROOT).keys()].filter((k) => k.endsWith('/SKILL.md')).map((k) => k.split('/')[0]);
  for (const must of ['ship-check', 'did-it-work', 'what-else', 'wrap-up', 'visual-qa']) assert.ok(names.includes(must), must);
});

test('apply_patch becomes one Claude Edit/Write event per file', () => {
  const patch = '*** Begin Patch\n*** Add File: a/new.js\n+one\n+two\n*** Update File: b/old.js\n@@\n-x\n+y\n*** Delete File: c/gone.js\n*** End Patch';
  const evs = adapter.toClaudeToolEvents('apply_patch', { command: patch });
  assert.deepEqual(evs.map((e) => [e.tool_name, e.tool_input.file_path]), [['Write', 'a/new.js'], ['Edit', 'b/old.js'], ['Edit', 'c/gone.js']]);
  assert.equal(evs[0].tool_input.content, 'one\ntwo');
  assert.equal(evs[1].tool_input.new_string, 'y');
  // A move reports both the source and the destination.
  const mv = adapter.toClaudeToolEvents('apply_patch', { command: '*** Begin Patch\n*** Update File: x.js\n*** Move to: y.js\n*** End Patch' });
  assert.deepEqual(mv.map((e) => e.tool_input.file_path), ['x.js', 'y.js']);
  assert.deepEqual(adapter.toClaudeToolEvents('Bash', { command: 'ls' }), [{ tool_name: 'Bash', tool_input: { command: 'ls' } }]);
  // Relative patch paths resolve against the session cwd, as Claude's Edit/Write carry absolute paths.
  const abs = adapter.toClaudeToolEvents('apply_patch', { command: '*** Begin Patch\n*** Update File: src/a.ts\n*** Update File: /abs/b.ts\n*** End Patch' }, '/repo/wt');
  assert.deepEqual(abs.map((e) => e.tool_input.file_path), ['/repo/wt/src/a.ts', '/abs/b.ts']);
});

test('user-level and project Claude hooks both run, identical commands once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-parity-'));
  const user = join(dir, 'user.json');
  const proj = join(dir, 'proj.json');
  writeFileSync(user, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-only.sh' }, { type: 'command', command: 'shared.sh' }] }] } }));
  writeFileSync(proj, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'shared.sh' }, { type: 'command', command: 'proj-only.sh' }] }] } }));
  const merged = adapter.loadSettings([user, join(dir, 'missing.json'), proj]);
  assert.deepEqual(adapter.claudeHooksFor(merged, 'Stop').map((h) => h.command), ['user-only.sh', 'shared.sh', 'proj-only.sh']);
});

test('a pending call is shown at PreToolUse but only persisted with its result', () => {
  const payload = { tool_use_id: 'c1', tool_response: 'ok' };
  const evs = [{ tool_name: 'Edit', tool_input: { file_path: '/x' } }];
  assert.deepEqual(adapter.toolRows(payload, evs, false).map((r) => r.kind), ['tool_use']);
  assert.deepEqual(adapter.toolRows(payload, evs, true).map((r) => r.kind), ['tool_use', 'tool_result']);
});

test('Claude matchers apply to the translated tool name', () => {
  assert.ok(adapter.matcherMatches('Bash|Edit|Write|NotebookEdit', 'Edit'));
  assert.ok(!adapter.matcherMatches('Bash', 'apply_patch'));
  assert.ok(adapter.matcherMatches('', 'anything'));
  assert.ok(adapter.matcherMatches('startup|clear|compact|resume', 'startup'));
  const pre = adapter.claudeHooksFor(settings, 'PreToolUse', 'Bash').map((h) => h.command);
  assert.ok(pre.some((c) => c.includes('block-resend-broadcasts.sh')));
  assert.ok(pre.some((c) => c.includes('worktree-enforce.sh')));
});

test('blocking output is recognised in every form Claude hooks use', () => {
  assert.ok(adapter.blockingOutput({ status: 2, stderr: 'no' }));
  assert.ok(adapter.blockingOutput({ status: 0, stdout: '{"decision":"block","reason":"r"}' }));
  assert.ok(adapter.blockingOutput({ status: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"r"}}' }));
  assert.equal(adapter.blockingOutput({ status: 0, stdout: '{"systemMessage":"fyi"}' }), null);
  assert.equal(adapter.blockingOutput({ status: 1, stderr: 'crash' }), null); // non-blocking error, as in Claude
});

test('shadow transcript is Claude-shaped and time-ordered', () => {
  const lines = adapter.buildShadowLines(
    [{ ts: '2026-01-01T00:00:01Z', role: 'user', text: 'do it', id: 'm1' }, { ts: '2026-01-01T00:00:05Z', role: 'assistant', text: 'done', id: 'm2' }],
    [{ kind: 'tool_use', ts: '2026-01-01T00:00:02Z', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', ts: '2026-01-01T00:00:03Z', id: 't1', content: 'a' }],
    'final words');
  assert.deepEqual(lines.map((l) => l.type), ['user', 'assistant', 'user', 'assistant', 'assistant']);
  assert.equal(lines[1].message.content[0].type, 'tool_use');
  assert.equal(lines[2].message.content[0].tool_use_id, 't1');
  assert.equal(lines[4].message.content[0].text, 'final words');
});

test('the adapter blocks a direct broadcast call end to end through the real Claude hook', () => {
  const host = ['api', 'resend', 'com'].join('.') + '/broad' + 'casts';
  const payload = { session_id: 'codex-parity-test', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: `echo https://${host}/x/send` }, tool_use_id: 't', transcript_path: '/nonexistent' };
  const res = spawnSync('node', [join(ROOT, 'scripts/codex/hook-adapter.js'), '--event', 'PreToolUse'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 120000 });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout.trim());
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /BROADCAST GUARD/);
});

test('install merges into ~/.codex without clobbering hand-set values', () => {
  const repoToml = 'web_search = "live"\n\n[sandbox_workspace_write]\nnetwork_access = true\n';
  const fresh = mergeToml('[projects."/x"]\ntrust_level = "trusted"\n', repoToml);
  assert.match(fresh.text, /^# added by[^\n]*\nweb_search = "live"\n/);
  assert.match(fresh.text, /\[sandbox_workspace_write\]\nnetwork_access = true/);
  assert.equal(mergeToml(fresh.text, repoToml).text, fresh.text); // idempotent
  const handSet = mergeToml('web_search = "cached"\n', repoToml);
  assert.equal(handSet.conflicts.length, 1);
  assert.match(handSet.text, /web_search = "cached"/);
  // A table set inline or with dotted keys is left alone (adding [t] would break the file).
  for (const home of ['sandbox_workspace_write.network_access = false\n', 'sandbox_workspace_write = { network_access = false }\n']) {
    const r = mergeToml(home, repoToml);
    assert.ok(!r.text.includes('[sandbox_workspace_write]'), home);
    assert.ok(r.conflicts.some((c) => c.startsWith('[sandbox_workspace_write]')), home);
  }
  const merged = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine.sh' }] }] } }, codexHooks);
  assert.ok(merged.hooks.Stop.some((g) => g.hooks.some((h) => h.command === 'mine.sh')));
  assert.equal(JSON.stringify(mergeHooks(merged, codexHooks)), JSON.stringify(merged)); // re-install replaces ours only
});
