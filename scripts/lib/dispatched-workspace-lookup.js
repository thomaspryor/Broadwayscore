/**
 * dispatched-workspace-lookup — resolve which LIVE cmux workspace is hosting
 * a given task, by cross-referencing dispatch-ledger.js's taskId->workspaceRef
 * record against a live `cmux list-workspaces` snapshot.
 *
 * Card #1465: a session that dispatches task #1464 via notion-brain.js
 * --dispatch has no way to find that workspace again later in the same
 * session — ListAgents shows session names with no cmux ref attached, and
 * `cmux list-workspaces` shows refs+titles with no ListAgents session name.
 * The dispatch-ledger already durably records the taskId->workspaceRef
 * mapping (see dispatch-ledger.js's openTaskWorkspaceLaunches); this module
 * just queries it for that purpose and guards against a stale/dead ref by
 * requiring the ref to also appear in a live cmux listing.
 *
 * Pure functions only — the caller (scripts/message-dispatched-workspace.js)
 * owns readEntries() and the `cmux list-workspaces` shell-out.
 */

'use strict';

const { openTaskWorkspaceLaunches, findRenumberedWorkspace, isWorkspaceRef } = require('./dispatch-ledger.js');

/**
 * Parse `cmux list-workspaces` plain-text output into [{ref, title, selected}].
 *
 * Verified live format (2026-08-14):
 *   "  workspace:1  ✳ Write AI musical comedy for Edinburgh Fringe"
 *   "* workspace:463  ◑ Identify and prioritize P0 backlog items  [selected]"
 */
function parseWorkspaceListing(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^\*?\s*(workspace:\d+)\s+(.*?)(?:\s{2,}\[selected\]\s*)?$/.exec(line);
    if (!m) continue;
    out.push({ ref: m[1], title: m[2], selected: /\[selected\]\s*$/.test(line) });
  }
  return out;
}

/**
 * Resolve the live workspace currently hosting `taskId`.
 *
 * Primary path: the ledger's open (unreconciled) launch for this taskId,
 * confirmed live in `liveWorkspaces`.
 *
 * Fallback: the ledger's ref is open but absent from `liveWorkspaces` (a
 * cmux restart renumbers every ref at once — same scenario dispatch-ledger's
 * looksLikeRestart guards elsewhere) — reuses dispatch-ledger.js's own
 * findRenumberedWorkspace() (the exact function it uses for its own
 * restart-vs-close disambiguation) rather than hand-rolling the same
 * title-match rule a second time.
 *
 * @param {string|number} taskId
 * @param {object[]} entries dispatch-ledger readEntries() output
 * @param {{ref:string,title:string}[]} liveWorkspaces parsed `cmux list-workspaces`
 * @returns {{ref:string,title:string,source:'ledger'|'title-fallback'}|null}
 */
function resolveWorkspaceForTask(taskId, entries, liveWorkspaces) {
  const launch = openTaskWorkspaceLaunches(entries || []).get(String(taskId));
  if (!launch || !isWorkspaceRef(launch.workspaceRef)) return null;

  const live = liveWorkspaces || [];
  const onScreen = live.find((w) => w.ref === launch.workspaceRef);
  if (onScreen) return { ref: onScreen.ref, title: onScreen.title, source: 'ledger' };

  const match = findRenumberedWorkspace(launch, live);
  if (match) return { ref: match.ref, title: match.title, source: 'title-fallback' };

  return null;
}

module.exports = { parseWorkspaceListing, resolveWorkspaceForTask };
