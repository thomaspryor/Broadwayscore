/**
 * session-wrapups — pure parsers for bsc-status.js.
 *
 * Owner pain (2026-07-22 night): finished sessions' cmux tabs vanish (tab +
 * worktree reaped after the claude process exits), taking the wrap-up
 * summary with them — the owner had no way to see WHAT a disappeared
 * session shipped, and had to open every remaining tab to judge "safe to
 * close?". These helpers recover both signals from the session jsonl
 * transcripts in ~/.claude/projects/<mangled-cwd>/, which survive tab
 * closure and worktree removal (they relocate to the main project dir).
 *
 * Everything here is pure string/array logic so it can be unit-tested
 * without a cmux socket or a real transcript on disk; bsc-status.js owns
 * the fs/ps/cmux side.
 */

'use strict';

function parseJsonLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail line from a partial read */ }
  }
  return out;
}

function messageText(obj) {
  const c = obj && obj.message && obj.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter(p => p && p.type === 'text').map(p => p.text || '').join(' ');
  }
  return '';
}

// First real user message — the dispatch prompt or the owner's opening ask.
// Skips system-reminder/hook noise (starts with '<') and empty entries.
function firstUserMessage(entries) {
  for (const e of entries) {
    if (e.type !== 'user') continue;
    const t = messageText(e).trim();
    if (t && !t.startsWith('<')) return t;
  }
  return '';
}

// Compress a first user message into a one-line label: dispatched sessions
// start "[#N] Title — Work on this card…"; keep the part before the
// dispatch boilerplate. Owner-typed messages just truncate.
function sessionLabel(firstMsg, max = 90) {
  const oneLine = String(firstMsg).replace(/\s+/g, ' ').trim();
  const m = /^(\[#\d+\][^—]*)(?:—|$)/.exec(oneLine);
  const label = (m ? m[1] : oneLine).trim();
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
}

// Last assistant message that contains any text (scanning backwards past
// trailing relocated / file-history-snapshot / hook entries).
function finalAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== 'assistant') continue;
    const t = messageText(entries[i]).trim();
    if (t) return t;
  }
  return '';
}

// The SESSION STATUS verdict line out of a wrap-up message. Every completion
// message ends with a "SAFE TO EXIT — …" / "NOT SAFE TO EXIT — …" line
// (exit-status-gate hook enforces); grab the LAST occurrence so quoted or
// restated earlier ones don't win.
function statusLine(text) {
  const matches = String(text).match(/(?:NOT )?SAFE TO EXIT\s*—[^\n]*/g);
  return matches ? matches[matches.length - 1].trim() : '';
}

// One-glance verdict for an open workspace. Inputs are booleans bsc-status
// derives from cmux (isDoneTitle / claudeAliveIn) — kept pure so the
// decision table is testable. Mirrors bsc-prune's closability rule: ✅ AND
// no live claude process is the only "safe to close" state. Un-marked
// no-process tabs get bsc-prune's neutral wording — they may be a dispatch
// that died mid-task OR a reference tab the owner keeps on purpose
// (feedback_never_close_unmarked_cmux_workspaces), so "review yourself".
function workspaceVerdict({ done, alive }) {
  if (done && !alive) return 'SAFE TO CLOSE';
  if (done) return 'DONE (claude still open — read it, then close)';
  if (alive) return 'WORKING — leave open';
  return 'IDLE un-marked — no claude process; review yourself';
}

module.exports = {
  parseJsonLines, messageText, firstUserMessage, sessionLabel,
  finalAssistantText, statusLine, workspaceVerdict,
};
