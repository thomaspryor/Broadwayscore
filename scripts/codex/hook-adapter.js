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
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHADOW_DIR = path.join(os.tmpdir(), 'codex-shadow');
const SHADOW_MAX_AGE_MS = 2 * 24 * 3600 * 1000;
// .codex/hooks.json gives the adapter 600s; stop short of it so a slow guard is
// reported as a timeout (non-blocking, as in Claude) instead of Codex killing us.
const BUDGET_MS = 570 * 1000;

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
// apply_patch paths are relative to the session cwd; Claude's Edit/Write always
// carry absolute paths, and guards such as worktree-enforce.sh rely on that.
function toClaudeToolEvents(toolName, toolInput, cwd) {
  const input = toolInput || {};
  if (toolName === 'apply_patch') {
    const patch = input.command || input.patch || input.input || '';
    const abs = (f) => (cwd && !path.isAbsolute(f) ? path.resolve(cwd, f) : f);
    return parseApplyPatch(patch).map((f) => (f.op === 'add'
      ? { tool_name: 'Write', tool_input: { file_path: abs(f.file), content: f.added.join('\n') } }
      : { tool_name: 'Edit', tool_input: { file_path: abs(f.file), old_string: '', new_string: f.added.join('\n') } }));
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

// Claude runs user-level (~/.claude/settings.json) and project hooks together.
// On the Mac several project hooks self-skip because a user-level copy exists,
// so reading only the project file would drop those guards for Codex.
// Identical commands run once, as Claude dedupes them.
function loadSettings(files) {
  const merged = { hooks: {} };
  const seen = new Set();
  for (const file of files) {
    let s; try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    for (const [event, groups] of Object.entries(s.hooks || {})) {
      for (const g of groups || []) {
        const hooks = (g.hooks || []).filter((h) => {
          const k = `${event}\0${g.matcher || ''}\0${h.command}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        if (hooks.length) (merged.hooks[event] = merged.hooks[event] || []).push({ ...g, hooks });
      }
    }
  }
  return merged;
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

// Sidecar rows for one tool call. PreToolUse only shows the pending call to its
// hooks; the call is persisted at PostToolUse, so a call a guard denied never
// appears in later transcripts as if it had run.
function toolRows(payload, claudeEvents, withResult) {
  const ts = new Date().toISOString();
  const rows = [];
  claudeEvents.forEach((ev, i) => {
    const id = `${payload.tool_use_id || 'codex'}#${i}`;
    rows.push({ key: `u:${id}`, kind: 'tool_use', ts, id, name: ev.tool_name, input: ev.tool_input });
    if (withResult) {
      const content = typeof payload.tool_response === 'string' ? payload.tool_response : JSON.stringify(payload.tool_response || '');
      rows.push({ key: `r:${id}`, kind: 'tool_result', ts, id, content });
    }
  });
  return rows;
}

function pruneShadowDir(now = Date.now()) {
  let names; try { names = fs.readdirSync(SHADOW_DIR); } catch { return; }
  for (const f of names) {
    const p = path.join(SHADOW_DIR, f);
    try { if (now - fs.statSync(p).mtimeMs > SHADOW_MAX_AGE_MS) fs.unlinkSync(p); } catch { /* raced */ }
  }
}

function writeShadowTranscript(payload) {
  const sid = String(payload.session_id || `unknown-${process.ppid}`).replace(/[^A-Za-z0-9_-]/g, '');
  fs.mkdirSync(SHADOW_DIR, { recursive: true });
  const sidecar = path.join(SHADOW_DIR, `${sid}.tools.jsonl`);
  const shadow = path.join(SHADOW_DIR, `${sid}.jsonl`);
  return { sidecar, shadow, build(pending = []) {
    const lines = buildShadowLines(rolloutMessages(payload.transcript_path), [...readSidecar(sidecar), ...pending], payload.last_assistant_message);
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

// Resolves to { status, stdout, stderr } like spawnSync. A timeout kills the
// hook and counts as a non-blocking error, as in Claude.
function runHook(hook, payload, env, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try { child = spawn('bash', ['-c', hook.command], { cwd, env, detached: true }); } catch (e) {
      resolve({ status: 1, stdout: '', stderr: String(e.message) });
      return;
    }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, Math.max(1000, timeoutMs));
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: 1, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
    child.stdin.on('error', () => { /* hook exited without reading stdin */ });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main() {
  const evIdx = process.argv.indexOf('--event');
  const event = evIdx > 0 ? process.argv[evIdx + 1] : null;
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { payload = {}; }
  const hookEvent = event || payload.hook_event_name;
  if (!hookEvent) process.exit(0);
  if (process.env.CODEX_HOOK_ADAPTER_LOG) {
    try { fs.appendFileSync(process.env.CODEX_HOOK_ADAPTER_LOG, JSON.stringify(payload) + '\n'); } catch { /* debug only */ }
  }

  const projectSettings = path.join(REPO_ROOT, '.claude', 'settings.json');
  if (!fs.existsSync(projectSettings)) {
    process.stderr.write('codex hook-adapter: no .claude/settings.json; guards skipped\n');
    process.exit(0);
  }
  const settings = loadSettings([path.join(os.homedir(), '.claude', 'settings.json'), projectSettings]);

  const cwd = payload.cwd && fs.existsSync(payload.cwd) ? payload.cwd : REPO_ROOT;
  const env = { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, CLAUDE_CODE_SESSION_ID: payload.session_id || '', CODEX_HOOK_ADAPTER: '1' };
  if (hookEvent === 'SessionStart') pruneShadowDir();
  const shadow = writeShadowTranscript(payload);

  const isTool = hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse';
  const claudeEvents = isTool ? toClaudeToolEvents(payload.tool_name, payload.tool_input, cwd) : [null];
  let pending = [];
  if (hookEvent === 'PreToolUse') pending = toolRows(payload, claudeEvents, false);
  else if (hookEvent === 'PostToolUse') {
    try { fs.appendFileSync(shadow.sidecar, toolRows(payload, claudeEvents, true).map((r) => JSON.stringify(r)).join('\n') + '\n'); } catch { /* best effort */ }
  }
  let transcriptPath = payload.transcript_path;
  try { transcriptPath = shadow.build(pending); } catch { /* fall back to the rollout path */ }

  const deadline = Date.now() + BUDGET_MS;
  const context = [];
  // Files of one apply_patch run in order (Claude would see separate calls);
  // the hooks for one call run in parallel, as Claude runs them.
  for (const ce of claudeEvents) {
    const matchValue = isTool ? ce.tool_name : (hookEvent === 'SessionStart' ? (payload.source || 'startup') : undefined);
    const claudePayload = { ...payload, hook_event_name: hookEvent, transcript_path: transcriptPath, ...(ce || {}) };
    const hooks = claudeHooksFor(settings, hookEvent, matchValue);
    const results = await Promise.all(hooks.map((hook) => runHook(hook, claudePayload, env, cwd,
      Math.min((hook.timeout || 60) * 1000, deadline - Date.now()))));
    for (const res of results) {
      const block = blockingOutput(res);
      if (block) {
        if (hookEvent === 'PreToolUse') {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: block.reason } }) + '\n');
        } else {
          process.stdout.write(JSON.stringify({ decision: 'block', reason: block.reason }) + '\n');
        }
        return; // let stdout drain; process.exit() can truncate a piped write
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
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`codex hook-adapter: ${e.stack || e}\n`); });
}

module.exports = { parseApplyPatch, toClaudeToolEvents, matcherMatches, loadSettings, claudeHooksFor, buildShadowLines, toolRows, blockingOutput, contextText };
