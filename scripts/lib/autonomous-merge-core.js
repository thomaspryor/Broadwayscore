/**
 * autonomous-merge-core.js — pure decision helpers for the CI merge path
 * (scripts/autonomous-merge.js, run by .github/workflows/autonomous-merge.yml).
 *
 * Oscillation breaker (S3-T2): the ledger the executor uses (data/audit/
 * autonomous-ledger.jsonl) is Mac-Studio-local and gitignored — GitHub Actions
 * has no access to it. Git history on main IS reachable from both sides and
 * is arguably the stronger source of truth for "did we already merge this
 * fix" (a ledger line proves an executor RAN; a commit trailer proves the
 * change actually LANDED). Every successful merge stamps a trailer on its
 * last commit; the merge workflow greps origin/main for it before merging
 * again. 2+ prior merges → hard stop, never auto-revert (owner spec).
 */

'use strict';

function oscillationTrailerFor(cardId) {
  return `Auto-merge-card: ${cardId}`;
}

function shouldEscalateOscillation(priorMergeCount) {
  return (Number(priorMergeCount) || 0) >= 2;
}

function buildEscalationNote(cardId, priorMergeCount) {
  return `## Autonomous merge REFUSED — oscillation guard (${new Date().toISOString().slice(0, 10)})\n` +
    `This card has already been merged ${priorMergeCount} time(s) (git history on main shows ${priorMergeCount} prior "${oscillationTrailerFor(cardId)}" commit(s)). ` +
    `The loop refuses to merge it again automatically — this needs your direct review, not another autonomous attempt.`;
}

function buildMergeOutcomeNote({ sha, branch, files }) {
  const fileList = (files || []).map(f => `- ${f}`).join('\n');
  return `## Autonomous merge (${new Date().toISOString().slice(0, 10)})\nMerged ${sha} from branch ${branch}.\n\nFiles:\n${fileList}\n\nUndo available from the morning email's revert link.`;
}

function buildReverifyFailNote(reason) {
  return `## Autonomous merge re-verify FAILED (${new Date().toISOString().slice(0, 10)})\n${String(reason || '').slice(0, 500)}\n\nApproval was stripped — the branch was NOT merged. A fresh tap is required to try again.`;
}

function buildRevertOutcomeNote({ revertSha, mergeSha }) {
  return `## Autonomous merge REVERTED (${new Date().toISOString().slice(0, 10)})\nReverted merge commit ${mergeSha} via ${revertSha}. The card is reopened — this needs a fresh look, the loop will not retry it automatically.`;
}

module.exports = {
  oscillationTrailerFor,
  shouldEscalateOscillation,
  buildEscalationNote,
  buildMergeOutcomeNote,
  buildReverifyFailNote,
  buildRevertOutcomeNote,
};
