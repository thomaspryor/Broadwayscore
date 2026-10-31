#!/usr/bin/env node
// scripts/lib/review-receipt.js (BRO-5411) — server-side evidence that a land
// branch's session ran a complete review (BRO-5359). The in-session gate lives
// in hooks; a stale cached container has none, so land.yml checks this receipt
// instead. A receipt is a commit-message trailer built from the evidence that
// review-coverage.mjs already produces ({outputsHash, invocationId, checks}).
//
// Pure functions only (CLAUDE.md rule 15); the CLIs are scripts/review-receipt.js.
'use strict';

const GATE_LINE_BUDGET = 30;
const TRAILER_RE = /^Review-Receipt:[ \t]*v1[ \t]+([0-9a-f]{64})[ \t]+(\S+)[ \t]*$/m;
const ANY_TRAILER_RE = /^Review-Receipt:/m;

function formatReceipt(evidence) {
  if (!evidence || !/^[0-9a-f]{64}$/.test(evidence.outputsHash || '') || !evidence.invocationId) return null;
  return `Review-Receipt: v1 ${evidence.outputsHash} ${String(evidence.invocationId).replace(/\s+/g, '')}`;
}

/** First valid receipt in a list of commit messages, else null. */
function parseReceipt(messages) {
  for (const m of [].concat(messages || [])) {
    const hit = TRAILER_RE.exec(String(m || ''));
    if (hit) return { outputsHash: hit[1], invocationId: hit[2] };
  }
  return null;
}

/**
 * @returns {{status:'not-required'|'present'|'missing'|'malformed', reason:string, receipt?:object}}
 */
function evaluateReceipt({ gatedLines = 0, messages = [], budget = GATE_LINE_BUDGET } = {}) {
  if (gatedLines <= budget) return { status: 'not-required', reason: `gated diff is ${gatedLines} lines (<= ${budget})` };
  const receipt = parseReceipt(messages);
  if (receipt) return { status: 'present', reason: 'review receipt trailer found', receipt };
  if ([].concat(messages || []).some((m) => ANY_TRAILER_RE.test(String(m || '')))) {
    return { status: 'malformed', reason: 'a Review-Receipt trailer exists but is not "v1 <64-hex> <id>"' };
  }
  return { status: 'missing', reason: `gated diff is ${gatedLines} lines and no Review-Receipt trailer (stale container, or a session that never stamped)` };
}

module.exports = { GATE_LINE_BUDGET, formatReceipt, parseReceipt, evaluateReceipt };
