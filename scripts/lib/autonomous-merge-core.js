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

const BASE_TRAILER_PREFIX = 'Auto-merge-base: ';

function oscillationTrailerFor(cardId) {
  return `Auto-merge-card: ${cardId}`;
}

// Strip any trailer lines a PRIOR (failed/retried) amend on this same commit
// already appended, so re-stamping on a later merge attempt is idempotent —
// without this, a second amend would append a second trailer block
// underneath the first, and a revert()'s search for Auto-merge-base would
// find the STALE (attempt-1) base sha instead of the one that actually merged.
function stripTrailers(message, trailer) {
  return String(message || '').split('\n')
    .filter(l => l !== trailer && !l.startsWith(BASE_TRAILER_PREFIX))
    .join('\n')
    .replace(/\n+$/, '')
    .trim();
}

// Parse the "Auto-merge-base: <sha>" trailer out of a commit message, if
// present. Returns null when absent (older merges predating this trailer, or
// a corrupted message) — callers fall back to a conservative single-commit
// revert in that case.
function parseBaseTrailer(message) {
  const line = String(message || '').split('\n').find(l => l.startsWith(BASE_TRAILER_PREFIX));
  return line ? line.slice(BASE_TRAILER_PREFIX.length).trim() : null;
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

// ── Tap-time staleness refusal (Sprint 2, S2-T5) ───────────────────────────
//
// The owner's Approve tap is a statement about ONE tree: the commit the
// executor checked and described in the morning email. Nothing stops that
// branch from moving between the email and the tap — a second night's
// checkpoint slice force-pushes it, or a human pushes a fix to it — and the
// merge path would then rebase, re-verify and merge a DIFFERENT tree under
// an approval that was never given for it. (Re-verification alone does not
// cover this: it proves the new tree passes checks, not that the owner saw
// it. A tier-3 diff is not test/docs-only, so "checks pass" was never
// sufficient to merge — that is exactly why the tap exists.)
//
// Fail OPEN on a missing evidence sha (pre-Sprint-2 comments have none):
// blocking every older approval would strand legitimate work, and those
// branches keep the full rebase + gate + checks path.
function stalenessRefusal(evidenceSha, branchSha) {
  const approved = String(evidenceSha || '').trim();
  const actual = String(branchSha || '').trim();
  if (!approved || !actual) return null;
  if (approved === actual) return null;
  return `the branch moved after the evidence you approved: you tapped Approve for commit ${approved.slice(0, 8)}, the branch now points at ${actual.slice(0, 8)}. Nothing was merged — a fresh overnight pass will re-post evidence for the new commit.`;
}

function buildRevertOutcomeNote({ revertSha, mergeSha }) {
  return `## Autonomous merge REVERTED (${new Date().toISOString().slice(0, 10)})\nReverted merge commit ${mergeSha} via ${revertSha}. The card is reopened — this needs a fresh look, the loop will not retry it automatically.`;
}

module.exports = {
  BASE_TRAILER_PREFIX,
  oscillationTrailerFor,
  stripTrailers,
  parseBaseTrailer,
  shouldEscalateOscillation,
  buildEscalationNote,
  buildMergeOutcomeNote,
  buildReverifyFailNote,
  buildRevertOutcomeNote,
  stalenessRefusal,
};
