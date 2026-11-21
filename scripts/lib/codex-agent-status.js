'use strict';
/**
 * Is the Codex Linear delegation actually connected, or silently dead?
 *
 * BRO-256: every Codex delegation since 2026-08-11 has failed with "Agent
 * didn't start — the request may not have reached the agent" (upstream
 * openai/codex#26898). scripts/lib/linear-delegation-health.js already
 * classifies any delegate's issues as 'never-started' when Linear creates no
 * agent session — this module narrows that to Codex specifically and rolls
 * per-issue verdicts up into one answer: is it safe to resume Claude/Codex
 * load-splitting, or is Claude (Cyrus) still carrying everything?
 *
 * Pure — the caller does the Linear API call and passes in issues shaped
 * like linear-delegation-health.js expects (delegateName + sessions).
 */

const { assessDelegations } = require('./linear-delegation-health');

function isCodexDelegate(name) {
  return /codex/i.test(String(name || ''));
}

/**
 * @param {Array} issues same shape assessDelegations takes
 * @param {number} [nowMs]
 * @returns {{status: 'connected'|'disconnected'|'unknown', verdicts: Array, detail: string}}
 */
function assessCodexAgentStatus(issues, nowMs = Date.now()) {
  const codexIssues = (issues || []).filter((i) => isCodexDelegate(i.delegateName));

  if (!codexIssues.length) {
    return { status: 'unknown', verdicts: [], detail: 'no Codex-delegated issues to judge from' };
  }

  const { verdicts } = assessDelegations(codexIssues, nowMs);

  // Any sign of real work — even one that later stalled — proves the request
  // DID reach the agent, which is the exact thing BRO-256 says is failing.
  const everStarted = verdicts.filter((v) => ['working', 'finished', 'stalled', 'blocked'].includes(v.verdict));
  if (everStarted.length) {
    return {
      status: 'connected',
      verdicts,
      detail: `${everStarted.length}/${verdicts.length} Codex delegation(s) produced a session — integration is reaching the agent`,
    };
  }

  // Every attempt has zero sessions ('never-started') or is still too fresh to
  // judge ('starting'). Only call it disconnected once every attempt is
  // conclusively never-started — a lone 'starting' issue is just new.
  const neverStarted = verdicts.filter((v) => v.verdict === 'never-started');
  if (neverStarted.length === verdicts.length) {
    return {
      status: 'disconnected',
      verdicts,
      detail: `${neverStarted.length}/${verdicts.length} Codex delegation(s) never created an agent session — matches BRO-256 / openai/codex#26898`,
    };
  }

  return { status: 'unknown', verdicts, detail: 'Codex delegation(s) too recent to judge' };
}

module.exports = { assessCodexAgentStatus, isCodexDelegate };
