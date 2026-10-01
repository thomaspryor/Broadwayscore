#!/usr/bin/env node
'use strict';
/**
 * compact-state.js — compaction checkpoint for Claude Code sessions.
 *
 * Why (Claude spend review, 2026-10-01, plan item 4): the project settings now
 * hold every session to a 200k context window and compact there instead of
 * letting context run to 600-780k in the 1M variants (71% of September's cloud
 * cost was sessions past 400k, re-read on every step). The plan-review
 * pre-mortem's top failure for that change was compaction dropping the one
 * fact a three-hour task depends on (which shows were already audited, which
 * verify commands passed, which card is open), so the session redoes work and
 * spend goes UP. This module makes compaction safe:
 *
 *   PreCompact  -> `write`   : parse the transcript, write a short checkpoint
 *                               (goal, open card, files edited, last commands,
 *                               evidence lines) to a per-session state file.
 *   SessionStart(source=compact) -> `restore` : print that checkpoint back as
 *                               hook additionalContext, so the first turn after
 *                               compaction sees it next to the summary.
 *
 * Both are driven by .claude/hooks/compact-state.sh (one script, both events).
 * Compaction fires about once per 200k tokens, so shelling into node here is
 * fine; the per-prompt-hook rule in scripts/lib/context-budget-policy.js does
 * not apply. Pure functions are exported for the unit test
 * (scripts/lib/compact-state.test.mjs); the CLI is `write` | `restore` | `auto`
 * (auto picks by hook_event_name/source in the stdin JSON).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STATE_DIR = path.join(process.env.TMPDIR || os.tmpdir(), 'bsc-compact-state');
const MAX_CHARS = 6000;          // keep the restored context small: it is re-read on every step
const KEEP_PROMPTS = 3;          // first prompt (the goal) + the last two
const KEEP_EDITS = 40;
const KEEP_BASH = 8;
const KEEP_EVIDENCE = 20;
const PROMPT_CHARS = 400;
const MAX_PROMPT_SOURCE_CHARS = 2000;  // longer user-role texts are skill bodies or pasted files, not the ask
const CMD_CHARS = 200;

const EVIDENCE_RE = /^(EXECUTED:|VERIFY:|PR-EVIDENCE:|DISPATCHED:|LANDED:|NO-VERIFY:|NO-SHIP-CHECK:|NO-CARD:|DECISION NEEDED:|PREVENTION:|RECHECK-AFTER:)/;
const CARD_RE = /\bBRO-\d+\b/g;
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
// User-role messages the harness injects (system reminders, subagent hand-backs, task
// notifications, routine wakes) are not the owner's ask and must not displace it.
const INJECTED_RE = /^(<|Another Claude session sent a message|\[SYSTEM NOTIFICATION|\[Subagent hand-back\])|<agent-message\b|<task-notification>|<wake reason=/;

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Parse a Claude Code transcript (JSONL text) into the durable facts a task needs after compaction. */
function parseTranscript(text) {
  const prompts = [];
  const edits = [];
  const bash = [];
  const evidence = [];
  const cards = new Set();
  const noteText = (t) => {
    for (const raw of String(t).split('\n')) {
      const l = raw.trim();
      if (EVIDENCE_RE.test(l)) evidence.push(l);
      for (const c of l.match(CARD_RE) || []) cards.add(c);
    }
  };
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o && o.message;
    if (!m || o.isSidechain) continue;
    if (o.type === 'user') {
      const c = m.content;
      const texts = typeof c === 'string' ? [c]
        : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text)
        : [];
      for (const t of texts) {
        const s = t.trim();
        // Skill bodies and pasted instruction files also arrive as user text; an owner's ask is short.
        if (!s || INJECTED_RE.test(s) || s.length > MAX_PROMPT_SOURCE_CHARS) continue;
        prompts.push(s);
        noteText(s);
      }
    } else if (o.type === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === 'text' && typeof b.text === 'string') noteText(b.text);
        else if (b.type === 'tool_use' && b.input) {
          if (EDIT_TOOLS.test(b.name) && b.input.file_path) edits.push(String(b.input.file_path));
          else if (b.name === 'Bash' && typeof b.input.command === 'string') bash.push(b.input.command);
        }
      }
    }
  }
  return { prompts, edits, bash, evidence, cards: [...cards] };
}

function gitSnapshot(cwd) {
  const run = (args) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); }
    catch { return ''; }
  };
  const branch = run(['branch', '--show-current']);
  const status = run(['status', '--short']).split('\n').filter(Boolean).slice(0, 30);
  const lastCommit = run(['log', '-1', '--format=%h %s']);
  return { branch, status, lastCommit };
}

function uniqueTail(arr, n) {
  const seen = new Set();
  const out = [];
  for (let i = arr.length - 1; i >= 0 && out.length < n; i--) {
    if (seen.has(arr[i])) continue;
    seen.add(arr[i]);
    out.unshift(arr[i]);
  }
  return out;
}

/** Render the checkpoint as markdown, capped at MAX_CHARS. */
function renderState(facts, git, now = new Date()) {
  const lines = [];
  lines.push(`# Compaction checkpoint (${now.toISOString().slice(0, 16)}Z, written automatically before context was compacted)`);
  lines.push('Treat this as the authoritative record of what was asked and what already happened; do not redo listed work.');
  const prompts = facts.prompts.length <= KEEP_PROMPTS ? facts.prompts
    : [facts.prompts[0], ...facts.prompts.slice(-(KEEP_PROMPTS - 1))];
  if (prompts.length) {
    lines.push('', '## What the owner asked (first, then latest)');
    for (const p of prompts) lines.push(`- ${truncate(p, PROMPT_CHARS)}`);
  }
  if (facts.cards.length) lines.push('', `## Linear cards mentioned: ${facts.cards.join(', ')}`);
  if (git && (git.branch || git.status.length || git.lastCommit)) {
    lines.push('', '## Git');
    if (git.branch) lines.push(`- branch: ${git.branch}`);
    if (git.lastCommit) lines.push(`- last commit: ${git.lastCommit}`);
    if (git.status.length) lines.push(`- uncommitted: ${git.status.join(' | ')}`);
  }
  const edits = uniqueTail(facts.edits, KEEP_EDITS);
  if (edits.length) {
    lines.push('', `## Files edited this session (${edits.length} most recent, unique)`);
    for (const f of edits) lines.push(`- ${f}`);
  }
  const bash = uniqueTail(facts.bash, KEEP_BASH);
  if (bash.length) {
    lines.push('', '## Last commands run');
    for (const c of bash) lines.push(`- \`${truncate(c, CMD_CHARS)}\``);
  }
  const ev = uniqueTail(facts.evidence, KEEP_EVIDENCE);
  if (ev.length) {
    lines.push('', '## Evidence and status lines already produced');
    for (const e of ev) lines.push(`- ${truncate(e, 300)}`);
  }
  let out = lines.join('\n');
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS - 20) + '\n…(truncated)';
  return out;
}

function statePath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
  return path.join(STATE_DIR, `${safe}.md`);
}

function writeCheckpoint(input) {
  const transcript = input.transcript_path && fs.existsSync(input.transcript_path)
    ? fs.readFileSync(input.transcript_path, 'utf8') : '';
  const facts = parseTranscript(transcript);
  const git = input.cwd ? gitSnapshot(input.cwd) : null;
  const md = renderState(facts, git);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const p = statePath(input.session_id);
  fs.writeFileSync(p, md);
  return p;
}

function restoreCheckpoint(input) {
  const p = statePath(input.session_id);
  if (!fs.existsSync(p)) return null;
  const md = fs.readFileSync(p, 'utf8');
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: md,
    },
  };
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function main(argv) {
  const mode = argv[2] || 'auto';
  let input = {};
  try { input = JSON.parse(readStdin() || '{}'); } catch { input = {}; }
  const event = input.hook_event_name || '';
  const want = mode !== 'auto' ? mode
    : event === 'PreCompact' ? 'write'
    : event === 'SessionStart' && input.source === 'compact' ? 'restore'
    : 'noop';
  if (want === 'write') { writeCheckpoint(input); return 0; }
  if (want === 'restore') {
    const out = restoreCheckpoint(input);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
    return 0;
  }
  return 0;
}

module.exports = { parseTranscript, renderState, statePath, writeCheckpoint, restoreCheckpoint, STATE_DIR, MAX_CHARS };

if (require.main === module) {
  let code = 0;
  try { code = main(process.argv); } catch { code = 0; } // fail-open: a checkpoint bug must never block compaction or a session start
  process.exit(code);
}
