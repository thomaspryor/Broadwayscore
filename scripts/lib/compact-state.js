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
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // a checkpoint older than this is stale (compaction and restore are seconds apart)
const KEEP_PROMPTS = 3;          // first prompt (the goal) + the last two
const KEEP_EDITS = 40;
const KEEP_BASH = 8;
const KEEP_EVIDENCE = 20;
const PROMPT_CHARS = 400;
const MAX_PROMPT_SOURCE_CHARS = 2000;  // longer user-role texts are skill bodies or pasted files, not the ask
const CMD_CHARS = 200;

const EVIDENCE_RE = /^(?:[-*]\s+)?(?:\*\*)?(EXECUTED:|VERIFY:|PR-EVIDENCE:|DISPATCHED:|LANDED:|NO-VERIFY:|NO-SHIP-CHECK:|NO-CARD:|DECISION NEEDED:|PREVENTION:|RECHECK-AFTER:)/;
const EVIDENCE_SECTION_CHARS = 2500; // so status lines can never crowd out the edited-files and commands sections
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
    // No isSidechain filter: a main transcript never carries sidechain lines (subagent
    // turns live in subagents/*.jsonl), and a subagent transcript flags EVERY line, so
    // filtering would hand a compacting subagent an empty checkpoint (found 2026-10-01).
    if (!m) continue;
    if (o.type === 'user') {
      // isMeta marks harness-injected user turns (skill bodies, hook feedback, agent
      // hand-backs); INJECTED_RE is the belt for transcripts that lack the flag.
      if (o.isMeta || o.isCompactSummary) continue;
      const c = m.content;
      const texts = typeof c === 'string' ? [c]
        : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text)
        : [];
      for (const t of texts) {
        const s = t.trim();
        if (!s || INJECTED_RE.test(s)) continue;
        // A long genuine ask (a pasted brief, a subagent task) is kept, truncated at render time.
        prompts.push(s.length > MAX_PROMPT_SOURCE_CHARS ? s.slice(0, MAX_PROMPT_SOURCE_CHARS) : s);
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

/**
 * Render the checkpoint as markdown, capped at MAX_CHARS. Sections are ordered
 * most-durable first (ask, cards, git, evidence) so the cap, when it bites,
 * drops whole trailing lines of the least important section (commands).
 */
function renderState(facts, git, now = new Date()) {
  const lines = [];
  lines.push(`# Compaction checkpoint (${now.toISOString().slice(0, 16)}Z, written automatically before context was compacted)`);
  lines.push('A snapshot of this session before its history was summarised. Use it to avoid repeating finished steps and to keep the original ask in view. It is not proof: prefer the current files and git state over this list, and re-verify anything that matters, especially after a revert or a change of task.');
  const many = facts.prompts.length > KEEP_PROMPTS;
  const prompts = many ? [facts.prompts[0], ...facts.prompts.slice(-(KEEP_PROMPTS - 1))] : facts.prompts;
  if (prompts.length) {
    lines.push('', '## What the owner asked (first, then latest)');
    prompts.forEach((p, i) => {
      // After many turns the first ask may have been superseded; say so rather than let it anchor the session.
      const tag = many && i === 0 ? 'original ask, may be superseded: ' : '';
      lines.push(`- ${tag}${truncate(p, PROMPT_CHARS)}`);
    });
  }
  if (facts.cards.length) lines.push('', `## Linear cards mentioned: ${facts.cards.join(', ')}`);
  if (git && (git.branch || git.status.length || git.lastCommit)) {
    lines.push('', '## Git');
    if (git.branch) lines.push(`- branch: ${git.branch}`);
    if (git.lastCommit) lines.push(`- last commit: ${git.lastCommit}`);
    if (git.status.length) lines.push(`- uncommitted: ${git.status.join(' | ')}`);
  }
  const ev = uniqueTail(facts.evidence, KEEP_EVIDENCE);
  if (ev.length) {
    lines.push('', '## Status lines the session wrote earlier (claims, not verification)');
    let used = 0;
    for (const e of ev) {
      const l = `- ${truncate(e, 300)}`;
      if (used + l.length > EVIDENCE_SECTION_CHARS) break;
      lines.push(l);
      used += l.length + 1;
    }
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
  let out = lines.join('\n');
  if (out.length > MAX_CHARS) {
    const cut = out.lastIndexOf('\n', MAX_CHARS - 20);
    out = out.slice(0, cut > 0 ? cut : MAX_CHARS - 20) + '\n…(truncated)';
  }
  return out;
}

/**
 * One state file per transcript, not per session_id: a subagent's PreCompact may
 * carry its parent's session_id, and its transcript lives at
 * <session>/subagents/agent-<id>.jsonl, so the transcript basename is the
 * distinguishing key when it is present. Falls back to session_id alone.
 */
const safeKey = (s) => String(s).replace(/[^A-Za-z0-9_.-]/g, '_');

function statePath(sessionId, transcriptPath) {
  const sid = safeKey(sessionId || 'unknown');
  const base = transcriptPath ? safeKey(path.basename(String(transcriptPath)).replace(/\.jsonl$/, '')) : '';
  const key = (base && base !== sid ? `${sid}__${base}` : sid).slice(0, 160);
  return path.join(STATE_DIR, `${key}.md`);
}

/**
 * Exact (session + transcript) first, then the plain session file, then the
 * newest file written for this session, preferring a main transcript's over a
 * subagent's. The last case covers a restore whose input omits transcript_path.
 */
function findStateFile(sessionId, transcriptPath) {
  const exact = statePath(sessionId, transcriptPath);
  if (fs.existsSync(exact)) return exact;
  // No exact match (the restore input carried no transcript_path, or a different one):
  // choose among every file written for this session by freshness, main before subagent.
  // Freshness matters: a plain-session file left by an older code path must not beat a
  // checkpoint written seconds ago (found by the end-to-end check, 2026-10-01).
  const sid = safeKey(sessionId || 'unknown');
  let names = [];
  try { names = fs.readdirSync(STATE_DIR).filter(f => (f === `${sid}.md` || f.startsWith(`${sid}__`)) && f.endsWith('.md')); } catch { return null; }
  if (!names.length) return null;
  const rank = (f) => {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(STATE_DIR, f)).mtimeMs; } catch { /* vanished */ }
    return { f, sub: f.includes('__agent-') ? 1 : 0, mtime };
  };
  const best = names.map(rank).sort((a, b) => a.sub - b.sub || b.mtime - a.mtime)[0];
  return path.join(STATE_DIR, best.f);
}

function writeCheckpoint(input) {
  const transcript = input.transcript_path && fs.existsSync(input.transcript_path)
    ? fs.readFileSync(input.transcript_path, 'utf8') : '';
  const facts = parseTranscript(transcript);
  const git = input.cwd ? gitSnapshot(input.cwd) : null;
  const md = renderState(facts, git);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  pruneStale();
  const p = statePath(input.session_id, input.transcript_path);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, md);
  fs.renameSync(tmp, p); // atomic: a concurrent restore never reads a half-written file
  return p;
}

/** Checkpoints nobody restored (a subagent's, an abandoned session's) are removed once stale. */
function pruneStale(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(STATE_DIR); } catch { return; }
  for (const f of names) {
    const p = path.join(STATE_DIR, f);
    try { if (now - fs.statSync(p).mtimeMs > MAX_AGE_MS) fs.unlinkSync(p); } catch { /* vanished */ }
  }
}

function logError(err) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'errors.log'), `${new Date().toISOString()} ${err && err.stack ? err.stack.split('\n')[0] : String(err)}\n`);
  } catch { /* nothing left to try */ }
}

/**
 * Restore consumes the file: a checkpoint is injected once, right after the
 * compaction that wrote it, and can never resurface stale on a later compaction
 * or a different task. Files older than MAX_AGE_MS are ignored for the same reason.
 */
function restoreCheckpoint(input) {
  const p = findStateFile(input.session_id, input.transcript_path);
  if (!p) return null;
  let md = null;
  try {
    const ageMs = Date.now() - fs.statSync(p).mtimeMs;
    if (ageMs <= MAX_AGE_MS) md = fs.readFileSync(p, 'utf8');
  } finally {
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }
  if (!md) return null;
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

module.exports = { parseTranscript, renderState, statePath, findStateFile, writeCheckpoint, restoreCheckpoint, pruneStale, STATE_DIR, MAX_CHARS, MAX_AGE_MS };

if (require.main === module) {
  let code = 0;
  // fail-open: a checkpoint bug must never block compaction or a session start,
  // but it is written to $STATE_DIR/errors.log rather than swallowed.
  try { code = main(process.argv); } catch (err) { logError(err); code = 0; }
  process.exit(code);
}
