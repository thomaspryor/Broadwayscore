#!/usr/bin/env node
'use strict';
// scripts/codex/hook-adapter.js: run Claude's own hooks for a Codex session.
//
// BRO-4745 (owner, 2026-10-05): a Codex worker must follow the same guards
// Claude does. Codex (0.160+) fires the same hook events with nearly the same
// stdin payload (tool_name "Bash" + tool_input.command), so instead of a
// second copy of every guard, .codex/hooks.json points each event at this
// adapter, which reads .claude/settings.json at run time and runs every
// matching Claude hook command unchanged. A hook added for Claude therefore
// applies to Codex with no extra wiring, and nothing can drift.
//
// Two shape differences are bridged here:
//   1. Codex edits files with apply_patch (one envelope, many files). Claude
//      hooks expect Edit/Write with tool_input.file_path, so each file in the
//      patch becomes its own Edit/Write payload, and any block wins.
//   2. transcript_path points at a Codex rollout, which Claude's transcript
//      readers cannot parse. We write a Claude-shaped shadow transcript (user
//      and assistant text from the rollout, tool calls from a sidecar this
//      adapter appends to on every tool event) and hand the hooks that path.
//
// Usage (from .codex/hooks.json): node scripts/codex/hook-adapter.js --event PreToolUse

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHADOW_DIR = path.join(os.tmpdir(), 'codex-shadow');

// apply_patch envelope -> [{ op: 'add'|'update'|'delete', file, added }]
function parseApplyPatch(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(line);
    if (m) {
      cur = { op: m[1].toLowerCase(), file: m[2], added: [] };
      out.push(cur);
      continue;
    }
    const mv = /^\*\*\* Move to: (.+?)\s*$/.exec(line);
    if (mv && cur) { out.push({ op: 'add', file: mv[1], added: cur.added }); continue; }
    if (cur && line.startsWith('+')) cur.added.push(line.slice(1));
  }
  return out;
}

// One Codex tool event -> the Claude-shaped tool events it stands for.
function toClaudeToolEvents(toolName, toolInput) {
  const input = toolInput || {};
  if (toolName === 'apply_patch') {
    const patch = input.command || input.patch || input.input || '';
    return parseApplyPatch(patch).map((f) => (f.op === 'add'
      ? { tool_name: 'Write', tool_input: { file_path: f.file, content: f.added.join('\n') } }
      : { tool_name: 'Edit', tool_input: { file_path: f.file, old_string: '', new_string: f.added.join('\n') } }));
  }
  if (toolName === 'exec_command' || toolName === 'shell') {
    const cmd = input.command || input.cmd;
    return [{ tool_name: 'Bash', tool_input: { command: Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '') } }];
  }
  return [{ tool_name: toolName, tool_input: input }];
}

// Claude matcher semantics: empty or "*" matches everything, otherwise an
// anchored regex over the tool name ("Bash|Edit", "mcp__github__(a|b)").
function matcherMatches(matcher, value) {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(`^(?:${matcher})$`).test(value || ''); } catch { return matcher === value; }
}

function claudeHooksFor(settings, event, matchValue) {
  const out = [];
  for (const group of (settings.hooks && settings.hooks[event]) || []) {
    if (matchValue !== undefined && !matcherMatches(group.matcher, matchValue)) continue;
    for (const h of group.hooks || []) if (h.type === 'command' && h.command) out.push(h);
  }
  return out;
}

// Rollout text messages that are real conversation, not injected context.
function rolloutMessages(rolloutPath) {
  const out = [];
  let text;
  try { text = fs.readFileSync(rolloutPath, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const p = r.payload || {};
    if (r.type !== 'response_item' || p.type !== 'message') continue;
    if (p.role !== 'user' && p.role !== 'assistant') continue;
    const body = (p.content || []).map((c) => c && c.text).filter(Boolean).join('\n');
    if (!body || (p.role === 'user' && /^<(environment_context|user_instructions|skills_instructions)/.test(body))) continue;
    out.push({ ts: r.timestamp || '', role: p.role, text: body, id: p.id });
  }
  return out;
}

function readSidecar(sidecarPath) {
  const seen = new Set();
  const out = [];
  let text;
  try { text = fs.readFileSync(sidecarPath, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (seen.has(r.key)) continue; // every hook process for one event appends; keep one
    seen.add(r.key);
    out.push(r);
  }
  return out;
}

// Claude transcript lines, ordered by timestamp (rollout and sidecar share ISO time).
function buildShadowLines(messages, toolEvents, lastAssistantMessage) {
  const items = [];
  for (const m of messages) {
    items.push({ ts: m.ts, line: { type: m.role, timestamp: m.ts, message: { id: m.id, role: m.role, content: [{ type: 'text', text: m.text }] } } });
  }
  for (const e of toolEvents) {
    if (e.kind === 'tool_use') {
      items.push({ ts: e.ts, line: { type: 'assistant', timestamp: e.ts, message: { id: e.id, role: 'assistant', content: [{ type: 'tool_use', id: e.id, name: e.name, input: e.input }] } } });
    } else if (e.kind === 'tool_result') {
      items.push({ ts: e.ts, line: { type: 'user', timestamp: e.ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: e.id, content: e.content }] } } });
    }
  }
  items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const lines = items.map((i) => i.line);
  const lastText = [...messages].reverse().find((m) => m.role === 'assistant');
  if (lastAssistantMessage && (!lastText || lastText.text !== lastAssistantMessage)) {
    const ts = new Date().toISOString();
    lines.push({ type: 'assistant', timestamp: ts, message: { id: 'codex-last', role: 'assistant', content: [{ type: 'text', text: lastAssistantMessage }] } });
  }
  return lines;
}

function recordToolEvents(sidecarPath, payload, claudeEvents) {
  const ts = new Date().toISOString();
  const kind = payload.hook_event_name === 'PreToolUse' ? 'tool_use' : 'tool_result';
  const rows = claudeEvents.map((ev, i) => {
    const id = `${payload.tool_use_id || 'codex'}#${i}`;
    return kind === 'tool_use'
      ? { key: `u:${id}`, kind, ts, id, name: ev.tool_name, input: ev.tool_input }
      : { key: `r:${id}`, kind, ts, id, content: typeof payload.tool_response === 'string' ? payload.tool_response : JSON.stringify(payload.tool_response || '') };
  });
  fs.appendFileSync(sidecarPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function writeShadowTranscript(payload) {
  const sid = String(payload.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '');
  fs.mkdirSync(SHADOW_DIR, { recursive: true });
  const sidecar = path.join(SHADOW_DIR, `${sid}.tools.jsonl`);
  const shadow = path.join(SHADOW_DIR, `${sid}.jsonl`);
  return { sidecar, shadow, build() {
    const lines = buildShadowLines(rolloutMessages(payload.transcript_path), readSidecar(sidecar), payload.last_assistant_message);
    const tmp = `${shadow}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
    fs.renameSync(tmp, shadow);
    return shadow;
  } };
}

// A hook's result is blocking when it exits 2 or emits a block/deny decision.
function blockingOutput(res) {
  if (res.status === 2) return { reason: (res.stderr || res.stdout || 'blocked by hook').trim() };
  const out = (res.stdout || '').trim();
  if (!out.startsWith('{')) return null;
  let j; try { j = JSON.parse(out); } catch { return null; }
  const hso = j.hookSpecificOutput || {};
  if (j.decision === 'block' || j.continue === false || hso.permissionDecision === 'deny') {
    return { reason: j.reason || hso.permissionDecisionReason || j.stopReason || 'blocked by hook', json: j };
  }
  return null;
}

function contextText(res) {
  const out = (res.stdout || '').trim();
  if (!out) return '';
  if (out.startsWith('{')) {
    try {
      const j = JSON.parse(out);
      return (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || j.systemMessage || '';
    } catch { /* plain text */ }
  }
  return out;
}

function runHook(hook, payload, env, cwd) {
  const timeoutMs = (hook.timeout || 60) * 1000;
  return spawnSync('bash', ['-c', hook.command], {
    input: JSON.stringify(payload), cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
  });
}

function main() {
  const evIdx = process.argv.indexOf('--event');
  const event = evIdx > 0 ? process.argv[evIdx + 1] : null;
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { payload = {}; }
  const hookEvent = event || payload.hook_event_name;
  if (!hookEvent) process.exit(0);

  let settings;
  try { settings = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8')); } catch (e) {
    process.stderr.write(`codex hook-adapter: cannot read .claude/settings.json (${e.message}); guards skipped\n`);
    process.exit(0);
  }

  const cwd = payload.cwd && fs.existsSync(payload.cwd) ? payload.cwd : REPO_ROOT;
  const env = { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, CLAUDE_CODE_SESSION_ID: payload.session_id || '', CODEX_HOOK_ADAPTER: '1' };
  const shadow = writeShadowTranscript(payload);

  const isTool = hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse';
  const claudeEvents = isTool ? toClaudeToolEvents(payload.tool_name, payload.tool_input) : [null];
  if (isTool) { try { recordToolEvents(shadow.sidecar, payload, claudeEvents); } catch { /* best effort */ } }
  let transcriptPath = payload.transcript_path;
  try { transcriptPath = shadow.build(); } catch { /* fall back to the rollout path */ }

  const context = [];
  for (const ce of claudeEvents) {
    const matchValue = isTool ? ce.tool_name : (hookEvent === 'SessionStart' ? (payload.source || 'startup') : undefined);
    const claudePayload = { ...payload, hook_event_name: hookEvent, transcript_path: transcriptPath, ...(ce || {}) };
    for (const hook of claudeHooksFor(settings, hookEvent, matchValue)) {
      const res = runHook(hook, claudePayload, env, cwd);
      const block = blockingOutput(res);
      if (block) {
        if (hookEvent === 'PreToolUse') {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: block.reason } }) + '\n');
        } else {
          process.stdout.write(JSON.stringify({ decision: 'block', reason: block.reason }) + '\n');
        }
        process.exit(0);
      }
      const text = contextText(res);
      if (text) context.push(text);
    }
  }
  if (context.length && (hookEvent === 'SessionStart' || hookEvent === 'UserPromptSubmit')) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: hookEvent, additionalContext: context.join('\n\n') } }) + '\n');
  } else if (context.length) {
    process.stdout.write(JSON.stringify({ systemMessage: context.join('\n\n').slice(0, 4000) }) + '\n');
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { parseApplyPatch, toClaudeToolEvents, matcherMatches, claudeHooksFor, buildShadowLines, blockingOutput, contextText };
