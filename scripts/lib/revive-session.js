/**
 * revive-session — detect a cmux workspace occupied by a claude process that
 * is missing --dangerously-skip-permissions, and restart it in place with
 * the flag re-applied (task #985).
 *
 * Root cause: cmux's OWN restart-recovery path (triggered when a dead pane
 * gets revived — see #886) resumes with a bare `claude --worktree X --resume
 * <sessionId>` command, composed outside this repo. Nothing here controls
 * that composition, so the fix is detect-and-correct after the fact rather
 * than prevent-at-source: every 🤖 auto-dispatched workspace's live claude
 * process is checked for the flag, and a flagless one is respawned in place
 * (same pane, same --resume session, flag restored) via `cmux respawn-pane`
 * — the tmux-compatible primitive that swaps a pane's running command
 * without closing the tab or losing scrollback.
 *
 * `cmux top --workspace X --processes --format tsv` reports one row per
 * node; the claude_code PROCESS row's `id` column IS the OS pid (verified
 * live, 2026-08-03: matches `ps -p <that pid>` for a real session). That's
 * the same predicate cmux-workspaces.js's hasLiveClaude uses to confirm a
 * claude process exists — reused here to also recover its pid.
 */

const { execFileSync } = require('child_process');
const cmuxws = require('./cmux-workspaces.js');
const ledger = require('./dispatch-ledger.js');

const CMUX = cmuxws.CMUX;

// Find the OS pid of the claude_code process for a workspace from `cmux top
// --processes --format tsv` output. Mirrors hasLiveClaude's predicate
// (type==='process' && parent ends in ':tag:claude_code') but returns the
// pid (the `id` column) instead of a boolean. Pure — exported for tests.
function findClaudeCodePid(tsvText) {
  for (const line of String(tsvText).split('\n')) {
    const c = line.split('\t');
    if (c[3] === 'process' && /:tag:claude_code$/.test(c[5] || '')) {
      const pid = parseInt(c[4], 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  }
  return null;
}

// Whether a ps command-line string is a claude invocation missing
// --dangerously-skip-permissions. Not a claude line at all → false (nothing
// to flag). Pure — exported for tests.
function isFlaglessClaudeCommand(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return false;
  if (!/\bclaude\b/.test(c)) return false;
  return !c.includes('--dangerously-skip-permissions');
}

// Rebuild a corrected launch command from a flagless one: preserve every
// existing arg (--worktree, --resume <sessionId>, etc.), insert --model
// <model> only if the original didn't already specify one (a --resume
// inherits its session's model and rarely carries --model itself, but never
// override one that IS present), and append the missing flag. Pure —
// exported for tests.
function composeReviveCommand(originalCommand, { model = null } = {}) {
  const cmd = String(originalCommand || '').trim();
  const idx = cmd.indexOf('claude');
  if (idx === -1) return cmd;
  const rest = cmd.slice(idx + 'claude'.length).trim();
  const parts = ['claude'];
  if (model && !/--model\b/.test(rest)) parts.push('--model', model);
  if (rest) parts.push(rest);
  if (!/--dangerously-skip-permissions/.test(rest)) parts.push('--dangerously-skip-permissions');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// Extract the first `surface:N` ref from `cmux list-pane-surfaces --workspace
// X` output (lines look like `* surface:138  <title>  [selected]` or
// `  surface:122  <title>`). Pure — exported for tests.
//
// `cmux respawn-pane --workspace X --command Y` alone is NOT sufficient —
// verified live, 2026-08-03: it throws `invalid_params: Surface is not a
// terminal` even against a workspace whose only surface IS a terminal
// (`surface-health` confirmed `type=terminal`). Passing the resolved
// `--surface` ref explicitly is what actually works. Every real 🤖
// auto-dispatched workspace has exactly one pane/one surface (cmux-launch.js
// never splits), so "first surface" is unambiguous in practice.
function findFirstSurfaceRef(listPaneSurfacesText) {
  const m = /surface:\d+/.exec(String(listPaneSurfacesText));
  return m ? m[0] : null;
}

// Detect whether `ref`'s current occupant is a live-but-flagless claude
// process. Fails safe to { flagless: false } on any I/O error or when no
// claude process can be found — this predicate gates a consequential auto-
// restart, so uncertainty must never masquerade as "flagged and safe to
// yank" (same fail-safe direction as cmux-workspaces.js's liveness checks).
function detectFlaglessSession(ref, deps = {}) {
  const {
    topTsvFn = (r) => cmuxws.run(['top', '--workspace', r, '--processes', '--format', 'tsv']),
    psCommandFn = (pid) => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }),
  } = deps;

  let tsv;
  try { tsv = topTsvFn(ref); } catch { return { flagless: false, pid: null, command: null }; }
  const pid = findClaudeCodePid(tsv);
  if (!pid) return { flagless: false, pid: null, command: null };

  let command;
  try { command = psCommandFn(pid); } catch { return { flagless: false, pid, command: null }; }
  const trimmed = String(command || '').split('\n')[0].trim();
  return { flagless: isFlaglessClaudeCommand(trimmed), pid, command: trimmed };
}

// Respawn `ref`'s pane in place with the flag restored. Returns
// { revived: false, reason } when there was nothing to fix (or detection was
// inconclusive), otherwise { revived: true, ref, pid, command }.
function reviveSession(ref, opts = {}) {
  const { deps = {} } = opts;
  const {
    detectFn = detectFlaglessSession,
    readLedgerEntriesFn = ledger.readEntries,
    launchByRefFn = ledger.launchByRef,
    listPaneSurfacesFn = (r) => cmuxws.run(['list-pane-surfaces', '--workspace', r]),
    respawnFn = (r, surfaceRef, command) => execFileSync(CMUX, ['respawn-pane', '--workspace', r, '--surface', surfaceRef, '--command', command], { encoding: 'utf8', timeout: 5000 }),
  } = deps;

  const detection = detectFn(ref, deps);
  if (!detection.command) return { revived: false, reason: 'no-claude-process-found', ref };
  if (!detection.flagless) return { revived: false, reason: 'already-flagged', ref };

  let surfaceRef;
  try { surfaceRef = findFirstSurfaceRef(listPaneSurfacesFn(ref)); } catch { surfaceRef = null; }
  if (!surfaceRef) return { revived: false, reason: 'no-surface-found', ref };

  let model = opts.model || null;
  if (!model) {
    try {
      const entries = readLedgerEntriesFn();
      const launch = launchByRefFn(ref, entries);
      model = (launch && launch.model) || null;
    } catch { /* ledger read failure — proceed without a model override */ }
  }

  const command = composeReviveCommand(detection.command, { model });
  respawnFn(ref, surfaceRef, command);
  return { revived: true, ref, pid: detection.pid, command };
}

module.exports = {
  findClaudeCodePid,
  isFlaglessClaudeCommand,
  composeReviveCommand,
  findFirstSurfaceRef,
  detectFlaglessSession,
  reviveSession,
};
