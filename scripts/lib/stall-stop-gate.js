#!/usr/bin/env node
'use strict';
/**
 * stall-stop-gate.js (BRO-7195): WAKEPROMISE for Mac sessions in EVERY repo.
 *
 * BRO-7183 added WAKEPROMISE (a closing that promises later action, "I'll check back", with nothing
 * running that would wake the session) to Broadwayscore's own Stop hook, .claude/hooks/verify-edits.sh.
 * A Mac session in any other repo never runs that hook: it gets only the global ~/.claude/settings.json
 * Stop list, and none of those had the check. ~/.claude/hooks/stall-stop-gate.sh runs this file with
 * `--stop-hook` from that list, so every Mac session gets it.
 *
 * Inside a Broadwayscore checkout the repo hook owns WAKEPROMISE (advisory there unless
 * PROMISE_GATE_MODE=block), so this gate steps aside: two copies would block twice, or turn the repo's
 * advisory check into a hard block by the back door.
 *
 * Decision (pure, wakePromiseDecision): block when the final closing matches the shared pattern
 * (wake-promise-patterns.json, also read by the repo hook), it is not a question to the owner, it holds
 * no DECISION NEEDED / "You need to: <something>" / NO-VERIFY:, and nothing live would wake the
 * session (liveWork: a background Bash/Monitor/Agent/Workflow with no completion notice inside its
 * timeout, an unfired ScheduleWakeup, a CronCreate not deleted). Uncertain liveness counts as live.
 *
 * Loop safety: at most one block per human turn, kept in ~/.claude/state/stall-stop-gate/<session>.json
 * (a per-gate ledger, not stop_hook_active: another Stop hook blocking first must not spend this one).
 * Every would-block is appended to ~/.claude/state/wake-promise-advisory.jsonl (source "global"), the
 * same ledger the repo hook writes, so the hit rate can be measured. STALL_STOP_GATE_MODE=advisory logs
 * without blocking; WAKEPROMISE_GATE_DISABLE=1 turns it off. Any error exits 0 (fail-open).
 *
 * Usage: node scripts/lib/stall-stop-gate.js --stop-hook   (Stop hook JSON on stdin)
 *        node scripts/lib/stall-stop-gate.js --scan <transcript.jsonl> [...]   (dry run, prints decisions)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PATTERNS = require('./wake-promise-patterns.json');
const PROMISE_RE = new RegExp(PATTERNS.promise, PATTERNS.flags || 'i');
const DECISION_RE = /^[\s>*_-]*DECISION NEEDED:/m;
const YOU_NEED_RE = /^\W*You need to:?\s*(.*)$/gim;
const NOTHING_RE = /^\W*(?:nothing|n\/?a|none|no(?: action)?\b|$)/i;
const DEFAULT_BG_TIMEOUT_MS = 2 * 60 * 60 * 1000; // a background task with no notice after 2h is not coming back
const WAKE_SLACK_MS = 10 * 60 * 1000;
const BG_TOOLS = new Set(['Bash', 'Monitor', 'Agent', 'Task', 'Workflow']);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' ? b.text : (b && typeof b.content === 'string' ? b.content : ''))).join('\n');
}

/** A real prompt from the human (or the headless prompt), not a tool result or a task notice. */
function isHumanPrompt(row) {
  if (!row || row.type !== 'user' || row.isMeta) return false;
  const c = row.message && row.message.content;
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  if (!t) return false;
  return !/^<(?:task-notification|system-reminder|local-command|command-name|cross-session-message)\b/.test(t);
}

/** JSONL text -> {closing, tools, notified, stopped, humanTurns} */
function parseTranscript(jsonl) {
  const rows = [];
  for (const line of String(jsonl || '').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  const tools = [];
  const byId = new Map();
  const notified = new Set();
  const stopped = new Set();
  let humanTurns = 0;
  let closingParts = [];
  for (const r of rows) {
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const c = r.message && r.message.content;
    if (r.type === 'user') {
      if (isHumanPrompt(r)) humanTurns += 1;
      const t = textOf(c);
      for (const m of t.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const body = m[1];
        if (!/<status>/.test(body)) continue; // a Monitor <event> is progress, not completion
        const tu = body.match(/<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/);
        const tk = body.match(/<task-id>\s*([^<\s]+)\s*<\/task-id>/);
        if (tu) notified.add(tu[1]);
        if (tk) notified.add(tk[1]);
      }
      if (Array.isArray(c)) {
        for (const b of c) {
          if (!b || b.type !== 'tool_result') continue;
          const tool = byId.get(b.tool_use_id);
          if (!tool) continue;
          const rt = typeof b.content === 'string' ? b.content : textOf(b.content);
          tool.result = String(rt || '').slice(0, 2000);
          tool.error = b.is_error === true || /^<tool_use_error>/.test(tool.result);
          const idm = tool.result.match(/\bwith ID:\s*([0-9A-Za-z_-]{4,})|\bMonitor started \(task\s+([0-9A-Za-z_-]{4,})|\bagentId:\s*([0-9A-Za-z_-]{4,})|\btask ID:?\s*([0-9A-Za-z_-]{4,})/i);
          if (idm) tool.taskId = idm[1] || idm[2] || idm[3] || idm[4];
        }
        // Any user row after the closing text means the closing is not final yet.
        if (c.some((b) => b && b.type === 'tool_result')) closingParts = [];
      }
      if (isHumanPrompt(r)) closingParts = [];
      continue;
    }
    if (!Array.isArray(c)) continue;
    let usedTool = false;
    for (const b of c) {
      if (b && b.type === 'tool_use') {
        usedTool = true;
        const t = { id: b.id, name: b.name, input: b.input || {}, at: Date.parse(r.timestamp) || null, humanTurn: humanTurns };
        tools.push(t);
        byId.set(b.id, t);
        if (b.name === 'TaskStop' || b.name === 'KillShell') stopped.add(String((b.input || {}).task_id || (b.input || {}).shell_id || (b.input || {}).taskId || ''));
      }
    }
    const txt = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    if (usedTool) closingParts = txt ? [txt] : [];
    else if (txt) closingParts.push(txt);
  }
  return { closing: closingParts.join('\n').trim(), tools, notified, stopped, humanTurns };
}

/** Live work that would wake the session. Returns a list of short labels (empty = nothing live). */
function liveWork({ tools, notified = new Set(), stopped = new Set(), nowMs = Date.now() }) {
  const live = [];
  const deletedCrons = new Set(tools.filter((t) => t.name === 'CronDelete').map((t) => String(t.input.id || t.input.job_id || '')));
  for (const t of tools) {
    if (t.error) continue;
    if (t.name === 'ScheduleWakeup') {
      if (t.input.stop === true) continue;
      const due = (t.at || 0) + Number(t.input.delaySeconds || 0) * 1000;
      if (!t.at || due + WAKE_SLACK_MS > nowMs) live.push('ScheduleWakeup');
      continue;
    }
    if (t.name === 'CronCreate') {
      const idm = String(t.result || '').match(/\b(?:id|job)[:\s"]+([0-9A-Za-z_-]{4,})/i);
      if (!idm || !deletedCrons.has(idm[1])) live.push('CronCreate');
      continue;
    }
    if (!BG_TOOLS.has(t.name)) continue;
    const isAgent = t.name === 'Agent' || t.name === 'Task' || t.name === 'Workflow';
    const background = t.name === 'Monitor' || t.input.run_in_background === true
      || (isAgent && t.input.run_in_background !== false);
    if (!background) continue;
    if (t.result === undefined) { live.push(`${t.name} (no result yet)`); continue; }
    // A foreground-completed agent returns its report inline.
    if (isAgent && /\bsubagent_tokens\b|<usage>|\[Subagent hand-back\]/.test(t.result)) continue;
    if (notified.has(t.id) || (t.taskId && (notified.has(t.taskId) || stopped.has(t.taskId)))) continue;
    const budget = Number(t.input.timeout) > 0 ? Number(t.input.timeout) : DEFAULT_BG_TIMEOUT_MS;
    if (t.at && nowMs - t.at > Math.max(budget, DEFAULT_BG_TIMEOUT_MS) && !isAgent) continue; // past its timeout
    live.push(`${t.name} ${t.taskId || t.id}`);
  }
  return live;
}

function unquoted(text) {
  return String(text || '').replace(/`[^`\n]*`/g, ' ').replace(/"[^"\n]{0,300}"/g, ' ').replace(/\u201c[^\u201d\n]{0,300}\u201d/g, ' ')
    .split('\n').filter((l) => !l.trimStart().startsWith('>')).join('\n');
}

function ownerMustAct(text) {
  const t = String(text || '').replace(/`[^`\n]*`/g, '').split('\n').filter((l) => !l.trimStart().startsWith('>')).join('\n');
  if (DECISION_RE.test(t)) return true;
  for (const m of t.matchAll(YOU_NEED_RE)) if (!NOTHING_RE.test(m[1].trim())) return true;
  return false;
}

/**
 * @param {{closing:string, live:string[]}} p
 * @returns {{block:boolean, reason:string, phrase?:string}}
 */
function wakePromiseDecision({ closing, live }) {
  const text = String(closing || '');
  if (!text.trim()) return { block: false, reason: 'no closing text' };
  if (/\bNO-VERIFY:/.test(text)) return { block: false, reason: 'NO-VERIFY: bypass' };
  // Quoted text is a description of a promise ("sessions end on \"I'll check back\""), not this session's own.
  const m = unquoted(text).match(PROMISE_RE);
  if (!m) return { block: false, reason: 'no promise of later action' };
  const lastPara = text.trim().split(/\n\s*\n/).pop() || '';
  if (lastPara.includes('?')) return { block: false, reason: 'ends on a question to the owner (the reply wakes it)' };
  if (ownerMustAct(text)) return { block: false, reason: 'waits on the owner (DECISION NEEDED / You need to:)' };
  if (live && live.length) return { block: false, reason: `live: ${live.slice(0, 3).join(', ')}`, phrase: m[0] };
  return { block: true, reason: 'promises later action with nothing running to wake the session', phrase: m[0] };
}

/** A Broadwayscore checkout (its repo hook already runs WAKEPROMISE). */
function isBroadwayscoreCheckout(cwd) {
  let d = path.resolve(cwd || '.');
  for (let i = 0; i < 40; i += 1) {
    if (fs.existsSync(path.join(d, '.claude', 'hooks', 'verify-edits.sh')) && fs.existsSync(path.join(d, 'scripts', 'lib', 'wake-promise-patterns.json'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
  return false;
}

function stateDir() { return path.join(os.homedir(), '.claude', 'state'); }

function blockedThisTurn(sessionId, humanTurns) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(stateDir(), 'stall-stop-gate', `${sessionId}.json`), 'utf8'));
    return s.turn === humanTurns;
  } catch { return false; }
}

function recordBlock(sessionId, humanTurns) {
  const dir = path.join(stateDir(), 'stall-stop-gate');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ turn: humanTurns, at: new Date().toISOString() }));
}

function logAdvisory(row) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(path.join(stateDir(), 'wake-promise-advisory.jsonl'), JSON.stringify(row) + '\n');
  } catch { /* best effort */ }
}

const BLOCK_MESSAGE = (d) => [
  `WAKEPROMISE (BRO-7195): your closing says "${d.phrase}", but nothing is running that would bring this session back.`,
  'A Mac session that stops here sits idle until someone notices. Pick one:',
  '  1. Finish the work now, in this turn, and close with what you verified.',
  '  2. Start what will wake you: a background Bash/Monitor on the thing you wait for, or ScheduleWakeup in /loop mode.',
  '  3. If it truly waits on the owner, say so with a DECISION NEEDED block or a "You need to:" line.',
  '  4. If the line is not a promise (quoted, hypothetical), add a line "NO-VERIFY: <why>".',
].join('\n');

/** The Stop-hook entry. Returns the exit code. */
function runStopHook(input, env = process.env, nowMs = Date.now()) {
  if (env.WAKEPROMISE_GATE_DISABLE === '1') return { code: 0 };
  const tp = input && input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return { code: 0 };
  if (isBroadwayscoreCheckout(input.cwd || process.cwd())) return { code: 0, reason: 'Broadwayscore checkout: the repo Stop hook owns WAKEPROMISE' };
  const parsed = parseTranscript(fs.readFileSync(tp, 'utf8'));
  const live = liveWork({ ...parsed, nowMs });
  const d = wakePromiseDecision({ closing: parsed.closing, live });
  if (!d.block) return { code: 0, reason: d.reason };
  const sessionId = String(input.session_id || env.CLAUDE_CODE_SESSION_ID || path.basename(tp, '.jsonl')).replace(/[^0-9A-Za-z_-]/g, '');
  const advisory = env.STALL_STOP_GATE_MODE === 'advisory';
  const already = blockedThisTurn(sessionId, parsed.humanTurns);
  logAdvisory({ at: new Date(nowMs).toISOString(), source: 'global', session: sessionId, cwd: input.cwd || '', phrase: d.phrase, blocked: !advisory && !already });
  if (advisory || already) return { code: 0, reason: already ? 'already blocked once this turn' : 'advisory mode' };
  recordBlock(sessionId, parsed.humanTurns);
  return { code: 2, message: BLOCK_MESSAGE(d) };
}

function main(argv) {
  if (argv[0] === '--scan') {
    for (const f of argv.slice(1)) {
      try {
        const st = fs.statSync(f);
        const parsed = parseTranscript(fs.readFileSync(f, 'utf8'));
        // Judge each transcript as of its own last write, not today.
        const d = wakePromiseDecision({ closing: parsed.closing, live: liveWork({ ...parsed, nowMs: st.mtimeMs }) });
        console.log(JSON.stringify({ file: f, block: d.block, reason: d.reason, phrase: d.phrase || null, tail: parsed.closing.slice(-160) }));
      } catch (e) { console.log(JSON.stringify({ file: f, error: e.message })); }
    }
    return 0;
  }
  if (argv[0] !== '--stop-hook') { console.error('usage: stall-stop-gate.js --stop-hook | --scan <transcript.jsonl>...'); return 1; }
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return 0; }
  try {
    const r = runStopHook(input);
    if (r.code === 2) process.stderr.write(r.message + '\n');
    return r.code;
  } catch { return 0; }
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch { process.exitCode = 0; }
}

module.exports = { parseTranscript, liveWork, wakePromiseDecision, runStopHook, isBroadwayscoreCheckout, isHumanPrompt, PROMISE_RE };
