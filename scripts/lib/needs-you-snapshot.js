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

// Pure: cross-reference persisted questions against live workspace titles.
function pendingDecisions(states, workspaces) {
  const byRef = new Map(workspaces.map(w => [w.ref, w.title]));
  return states
    .filter(s => s && s.ref && byRef.has(s.ref))
    .map(s => ({ ...s, title: byRef.get(s.ref) }))
    .filter(s => isNeedsYouTitle(s.title));
}

function buildNeedsYouSnapshot({ dir = NEEDS_YOU_DIR } = {}) {
  if (!cmuxAvailable()) return null;
  let workspaces;
  try { workspaces = listWorkspaces(); } catch { return null; }
  const pending = pendingDecisions(readNeedsYouState(dir), workspaces)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return {
    generatedAt: new Date().toISOString(),
    bannerText: pending.length
      ? `${pending.length} tab${pending.length === 1 ? '' : 's'} waiting on your decision`
      : 'Nothing waiting on you',
    items: pending.map(p => ({ title: p.title, detail: p.question || '(no question captured)' })),
  };
}

module.exports = {
  NEEDS_YOU_DIR, readNeedsYouState, isNeedsYouTitle, pendingDecisions, buildNeedsYouSnapshot,
};
