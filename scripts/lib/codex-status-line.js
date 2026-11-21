'use strict';
/**
 * Codex connection status for the morning digest (BRO-2452).
 *
 * check-linear-delegations.js feeds buildCodexIssues() + assessCodexAgentStatus()
 * and stores the verdict under `codex` in ~/.cyrus/linear-delegation-status.json;
 * send-morning-digest.js turns it into one line with codexLineFromStatus().
 * All pure so both halves are testable without Linear or a Cyrus home.
 *
 * Kept SEPARATE from the stall alarm on purpose: a Codex delegation with no
 * session is the known BRO-256 outage, and feeding it to assessDelegations()
 * would alarm and exit 1 every 30 minutes until Codex is fixed.
 */

const { assessCodexAgentStatus, isCodexDelegate } = require('./codex-agent-status');

// Rolling, not a fixed outage date: a session from months ago must not read as
// "connected" after Codex breaks again.
const CODEX_EVIDENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// A delegation younger than this has not had a chance to start (the checker
// runs every 30 min), so it is not evidence of an outage.
const FRESH_DELEGATION_MS = 15 * 60 * 1000;

// Same bar as the stall alarm's reader in send-morning-digest.js.
const STATUS_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * @param {Array} sessionIssues issues grouped from agentSessions, open AND closed
 *   ({identifier, delegateName, open, sessions})
 * @param {Array} openDelegated open issues Linear lists with a delegate
 *   ({identifier, delegateName}); the only way to see ones with zero sessions
 * @returns {Array} issues shaped for assessCodexAgentStatus
 */
function buildCodexIssues(sessionIssues, openDelegated, nowMs = Date.now()) {
  const byId = new Map();
  const outOfWindow = new Set();
  for (const i of sessionIssues || []) {
    if (!isCodexDelegate(i.delegateName)) continue;
    const sessions = (i.sessions || []).filter((s) => {
      const ms = Date.parse(s.createdAt);
      return Number.isFinite(ms) && nowMs - ms <= CODEX_EVIDENCE_WINDOW_MS;
    });
    // Only sessions from outside the window: says nothing about today, and must
    // not turn into a zero-session "never started" issue.
    if (!sessions.length && (i.sessions || []).length) {
      outOfWindow.add(i.identifier);
      continue;
    }
    byId.set(i.identifier, { identifier: i.identifier, delegateName: i.delegateName, open: i.open, sessions });
  }
  for (const i of openDelegated || []) {
    if (!isCodexDelegate(i.delegateName) || outOfWindow.has(i.identifier)) continue;
    if (!byId.has(i.identifier)) {
      const updatedMs = Date.parse(i.updatedAt);
      if (Number.isFinite(updatedMs) && nowMs - updatedMs < FRESH_DELEGATION_MS) continue;
      byId.set(i.identifier, { identifier: i.identifier, delegateName: i.delegateName, open: true, sessions: [], updatedAt: i.updatedAt });
    } else {
      byId.get(i.identifier).open = true;
    }
  }
  // A closed issue with no recent session says nothing about today.
  return [...byId.values()].filter((i) => i.open || i.sessions.length);
}

/** @returns {{status, detail}} — `unknown` when the sessions list was truncated. */
function assessCodexForStatusFile(sessionIssues, openDelegated, { truncated = false, nowMs = Date.now() } = {}) {
  if (truncated) {
    return { status: 'unknown', detail: 'session list hit its page limit, so Codex could not be judged' };
  }
  const issues = buildCodexIssues(sessionIssues, openDelegated, nowMs);
  const { status, detail } = assessCodexAgentStatus(issues, nowMs);
  // One earlier success must not hide a new outage: if an open delegation was
  // made after the newest session ever started and still has none, Codex has
  // stopped reaching the agent again.
  if (status === 'connected') {
    const newestSession = Math.max(0, ...issues.flatMap((i) => i.sessions.map((s) => Date.parse(s.createdAt))));
    const newestStuck = Math.max(0, ...issues.filter((i) => !i.sessions.length).map((i) => Date.parse(i.updatedAt) || 0));
    if (newestStuck > newestSession) {
      return { status: 'disconnected', detail: 'a newer Codex delegation never created an agent session, after earlier ones did — matches BRO-256 / openai/codex#26898' };
    }
  }
  return { status, detail };
}

/**
 * Digest line, or null when there is nothing trustworthy to say (file missing,
 * stale, written before this field existed). Null renders nothing: an
 * "unknown" line every morning is noise.
 */
function codexLineFromStatus(statusFile, nowMs = Date.now()) {
  const c = statusFile && statusFile.codex;
  if (!c || typeof c.status !== 'string') return null;
  const ageMs = nowMs - Date.parse(statusFile.at);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > STATUS_MAX_AGE_MS) return null;
  if (c.status === 'connected') return 'Codex: connected. Work can be shared between Claude and Codex again.';
  if (c.status === 'disconnected') return 'Codex: disconnected (matches BRO-256). Claude is carrying all delegated work.';
  return null;
}

module.exports = { buildCodexIssues, assessCodexForStatusFile, codexLineFromStatus, CODEX_EVIDENCE_WINDOW_MS, STATUS_MAX_AGE_MS };
