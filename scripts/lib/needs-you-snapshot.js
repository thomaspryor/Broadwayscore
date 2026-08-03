/**
 * needs-you-snapshot — {generatedAt, bannerText, items} view of pending-
 * decision cmux tabs for the "Needs You" tab triage (card #870, owner pain
 * 2026-08-02: "giant list of tabs and I can't tell which ones actually need
 * decisions from me"). Shared by bsc-needs-you.js (one-shot CLI) and
 * send-morning-digest.js (digest section) — same pattern as the other
 * lib/*.js modules used by more than one caller.
 *
 * State is written by ~/.claude/hooks/lib/workspace-mark-done.js: whenever a
 * session's final message carries a `DECISION NEEDED:` line, that hook
 * ❓-prefixes the workspace title AND drops a small JSON at
 * ~/.claude/state/needs-you/<ref>.json with the captured question. This
 * module reads that state and cross-references it against LIVE cmux
 * workspaces — a tab only counts if it's still open AND still carries the ❓
 * prefix, so a resolved decision or a closed tab never shows a stale
 * question (the hook clears the state file on resolution, but title + state
 * writes are two separate fs calls, so a crash between them is possible).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { cmuxAvailable, listWorkspaces } = require('./cmux-workspaces.js');

const NEEDS_YOU_DIR = process.env.CLAUDE_CODE_NEEDS_YOU_DIR
  || path.join(os.homedir(), '.claude', 'state', 'needs-you');

function readNeedsYouState(dir = NEEDS_YOU_DIR) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

// A ❓ must lead within the same glyph zone workspace-mark-done.js itself
// tolerates (cmux's activity-glyph prefix in list output).
function isNeedsYouTitle(title) {
  return String(title || '').trim().slice(0, 4).includes('❓');
}

// Card #940 (owner screenshot 2026-08-03): a session sometimes emits a stub
// "DECISION NEEDED: none — no pending decision" line instead of omitting the
// block entirely when it has nothing to ask. workspace-mark-done.js's
// hasDecisionNeeded() only pattern-matches the literal "DECISION NEEDED:"
// prefix — it can't tell that stub apart from a real question — so the ❓
// glyph and the extracted content disagree: the title says "waiting on
// you", the content says there's nothing to wait on. Any "none"-shaped (or
// empty) extraction is treated as no pending decision, never rendered.
// Ambiguous bare words only count as empty when immediately followed by
// end-of-string or punctuation — "none of the 3 vendors quoted under
// budget..." is a real decision, not a stub, even though it starts with
// "none".
const BARE_EMPTY_RE = /^\s*(none|n\/a|nothing)\s*(?:[.,;:\-—–]|$)/i;
// "no decision"-shaped phrasings — same termination discipline as
// BARE_EMPTY_RE above: "No decision has been made about vendor X — should
// we wait?" is a real question that happens to start with "No decision",
// not a stub, so the phrase must end (punctuation or end-of-string)
// immediately after the stub shape, not just match as a prefix.
const PHRASE_EMPTY_RE = /^\s*no\s+(?:pending\s+)?decision(?:\s+(?:needed|pending))?\s*(?:[.,;:\-—–]|$)|^\s*nothing\s+pending\s*(?:[.,;:\-—–]|$)/i;
function isEmptyDecisionContent(question) {
  const q = String(question || '').trim();
  if (!q) return true;
  return BARE_EMPTY_RE.test(q) || PHRASE_EMPTY_RE.test(q);
}

// Pure: cross-reference persisted questions against live workspace titles,
// dropping any whose extracted content is empty/none regardless of glyph.
function pendingDecisions(states, workspaces) {
  const byRef = new Map(workspaces.map(w => [w.ref, w.title]));
  return states
    .filter(s => s && s.ref && byRef.has(s.ref))
    .map(s => ({ ...s, title: byRef.get(s.ref) }))
    .filter(s => isNeedsYouTitle(s.title))
    .filter(s => !isEmptyDecisionContent(s.question));
}

function buildNeedsYouSnapshot({ dir = NEEDS_YOU_DIR } = {}) {
  if (!cmuxAvailable()) return null;
  let workspaces;
  try { workspaces = listWorkspaces(); } catch { return null; }
  const states = readNeedsYouState(dir);
  const pending = pendingDecisions(states, workspaces)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  // Glyph/content mismatch count (card #940): ❓-titled tabs whose extracted
  // question was empty/none, so they were excluded above. Logged, not
  // thrown — this must never block the digest, only make the mismatch
  // visible for the hook-side extraction bug it points at.
  const byRef = new Map(workspaces.map(w => [w.ref, w.title]));
  const glyphMatched = states.filter(s => s && s.ref && byRef.has(s.ref) && isNeedsYouTitle(byRef.get(s.ref)));
  const mismatches = glyphMatched.length - pending.length;
  if (mismatches > 0) {
    console.error(`[needs-you] WARN ${mismatches} tab(s) ❓-marked but decision content was empty/none — excluded from "Needs your decision"`);
  }
  return {
    generatedAt: new Date().toISOString(),
    bannerText: pending.length
      ? `${pending.length} tab${pending.length === 1 ? '' : 's'} waiting on your decision`
      : 'Nothing waiting on you',
    items: pending.map(p => ({ title: p.title, detail: p.question || '(no question captured)' })),
  };
}

module.exports = {
  NEEDS_YOU_DIR, readNeedsYouState, isNeedsYouTitle, isEmptyDecisionContent, pendingDecisions, buildNeedsYouSnapshot,
};
