/**
 * autonomous-notion-evidence.js — durable per-card evidence for the CI merge
 * path (Sprint 3, Notion 39b637c5).
 *
 * Problem: the executor's ledger (data/audit/autonomous-ledger.jsonl) is
 * Mac-Studio-local and gitignored (S2-T7 dead-man note) — GitHub Actions
 * (where autonomous-merge.yml re-verifies the rebased diff) has no access to
 * it. The card's checkableDone command (from the triage queue, also
 * Mac-local and ephemeral) must survive from "executor pushed a branch" to
 * "CI re-verifies it, possibly days later" — the one place both sides can
 * read is the Notion card itself.
 *
 * The executor posts ONE Notion comment per pass, with a machine-parseable
 * marker line; the merge workflow reads the card's comments and takes the
 * LATEST evidence comment (a card can accumulate several across retries).
 * Pure build/parse here; network I/O (postEvidenceComment/fetchLatestEvidence)
 * takes an already-authenticated fetch-like function so this stays testable
 * without a live Notion connection.
 */

'use strict';

const MARKER = '[auto-evidence]';

/**
 * @param {{branch:string, files:string[], checkableDone?:string|null, checks?:string[], repoKey?:string|null, dataClass?:string|null, showIds?:string[]}} evidence
 * @returns {string} a Notion rich_text comment body
 */
function evidenceCommentText(evidence) {
  const payload = {
    branch: evidence.branch,
    files: evidence.files || [],
    checkableDone: evidence.checkableDone || null,
    checks: evidence.checks || [],
    // Tier-2 only (Sprint 4): which private repo + card class this evidence
    // belongs to, so autonomous-merge.yml's data path knows which repo to
    // check out WITHOUT trusting the (untrusted) card text — repoKey/dataClass
    // are stamped by the executor from its own classifyDataCard() call, never
    // read back from the card's title/notes at merge time.
    repoKey: evidence.repoKey || null,
    dataClass: evidence.dataClass || null,
    showIds: Array.isArray(evidence.showIds) ? evidence.showIds : [],
  };
  return `${MARKER} ${JSON.stringify(payload)}`;
}

/**
 * @param {string} text - a single comment's plain text
 * @returns {{branch:string, files:string[], checkableDone:string|null, checks:string[], repoKey:string|null, dataClass:string|null, showIds:string[]}|null}
 */
function parseEvidenceComment(text) {
  const t = String(text || '');
  if (!t.startsWith(MARKER)) return null;
  try {
    const payload = JSON.parse(t.slice(MARKER.length).trim());
    if (!payload || typeof payload.branch !== 'string') return null;
    return {
      branch: payload.branch,
      files: Array.isArray(payload.files) ? payload.files : [],
      checkableDone: typeof payload.checkableDone === 'string' ? payload.checkableDone : null,
      checks: Array.isArray(payload.checks) ? payload.checks : [],
      repoKey: typeof payload.repoKey === 'string' ? payload.repoKey : null,
      dataClass: typeof payload.dataClass === 'string' ? payload.dataClass : null,
      showIds: Array.isArray(payload.showIds) ? payload.showIds : [],
    };
  } catch {
    return null;
  }
}

/**
 * Pick the newest evidence comment for a given branch out of a Notion
 * comments-list response's `results` array (each result has a
 * `rich_text: [{plain_text}]` shape and a `created_time`). Returns null if
 * none match — the merge workflow falls back to tsc+colocated-tests only.
 */
function latestEvidenceForBranch(commentResults, branch) {
  const parsed = (commentResults || [])
    .map(c => ({
      createdTime: c.created_time || c.createdTime || null,
      evidence: parseEvidenceComment((c.rich_text || []).map(r => r.plain_text || '').join('')),
    }))
    .filter(c => c.evidence && c.evidence.branch === branch)
    .sort((a, b) => new Date(a.createdTime || 0) - new Date(b.createdTime || 0));
  return parsed.length ? parsed[parsed.length - 1].evidence : null;
}

module.exports = { MARKER, evidenceCommentText, parseEvidenceComment, latestEvidenceForBranch };
