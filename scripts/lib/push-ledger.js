/**
 * push-ledger.js — pure functions for the CI-side push ledger (task #677).
 *
 * push-with-retry.sh runs on ephemeral GitHub Actions runners: it cannot
 * spawn a background process that survives past job completion the way
 * merge-worktree-to-main.sh's local-session mitigation does (task #668,
 * scripts/verify-merge-landed.js). So the CI-side mitigation instead
 * durably records {sha, branch, ts, workflow} for every successful push on
 * the dedicated single-commit `push-ledger` branch (scripts/record-push-
 * ledger.js via scripts/lib/push-ledger-store.js — NOT commits to main;
 * see the store's header for the 2026-08-02 commit-churn rationale), and
 * a scheduled workflow (check-push-ledger.yml -> scripts/check-push-ledger.js)
 * re-checks recent entries' reachability against origin via the GitHub
 * compare API (scripts/lib/gh-compare-check.js), on a delay long enough for
 * the #668/#619 revert class to have already happened.
 *
 * Pure/testable logic lives here per CLAUDE.md's test-extraction rule; the
 * git plumbing (fetch/commit/push, gh api calls) lives in the two CLI
 * scripts above.
 */
'use strict';

function buildLedgerEntry({ sha, branch, ts, workflow, runId, runAttempt, fallbackUsed }) {
  if (!sha) throw new Error('buildLedgerEntry: sha is required');
  return JSON.stringify({
    sha,
    branch: branch || 'main',
    ts: ts || new Date().toISOString(),
    workflow: workflow || '',
    runId: runId || '',
    runAttempt: runAttempt || '',
    // task #707 canary (2026-08-16): true when this push landed via the Git
    // Data API fallback rather than a normal local rebase+push — lets the
    // digest distinguish "fallback fixed an occasional race" from "normal
    // pushes are now always exhausting first" (plan-review finding).
    fallbackUsed: Boolean(fallbackUsed),
  });
}

// Entry builder for the SEPARATE push-retry-failures ledger (task:
// push-retry-failure telemetry, 2026-08-23) — mirrors record_push_failure()'s
// existing field set in scripts/lib/push-with-retry.sh so both the local
// PUSH_FAILURE_LOG line and this durable entry carry identical data.
// Deliberately its own builder (not buildLedgerEntry): failure entries have
// no `sha` — the push never landed — so they can't share that function's
// required-field contract.
function buildFailureEntry({ reason, attempt, maxRetries, branch, remote, workflow, ci, ts }) {
  if (!reason) throw new Error('buildFailureEntry: reason is required');
  return JSON.stringify({
    reason,
    attempt: attempt || 0,
    maxRetries: maxRetries || 0,
    branch: branch || 'main',
    remote: remote || '',
    workflow: workflow || '',
    ci: Boolean(ci),
    ts: ts || new Date().toISOString(),
  });
}

// Detects whether the current process is running inside a GitHub Actions
// runner, for the `ci` field on buildFailureEntry() above (task #1901).
// Deliberately narrower than the repo's other CI-detection helpers (e.g.
// owner-alert-router.js's isCIExecution(), which also checks the generic
// `CI` var) — this one exists ONLY to mirror scripts/lib/push-with-retry.sh's
// own bash check (`[ -n "${GITHUB_ACTIONS:-}" ]`), which record_push_failure()
// uses for both the local PUSH_FAILURE_LOG line and the --ci arg passed to
// scripts/record-push-retry-failure.js. Keeping the two checks structurally
// identical (both GITHUB_ACTIONS-only) is the point — a caller wanting the
// broader CI||GITHUB_ACTIONS check should use isCIExecution() instead, not
// this function.
function isGithubActionsRunner(env = process.env) {
  return Boolean(env && env.GITHUB_ACTIONS);
}

// Parses JSONL content into entries, silently skipping blank/malformed lines
// (a single corrupted line — e.g. a partial write from a killed runner —
// must never take down the whole ledger). `requiredFields` (all must be
// present as strings) lets callers reuse this parser for entry shapes other
// than the original {sha, ts} push-success ledger — e.g. the push-retry-
// failures ledger's {reason, ts} — instead of duplicating this loop's
// trim/split/JSON.parse/try-catch skeleton per ledger (code-design
// plan-review finding, 2026-08-23: near-identical modules are a permanent
// duplication tax).
function parseLedgerLines(content, requiredFields = ['sha', 'ts']) {
  if (!content) return [];
  const entries = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && requiredFields.every((f) => typeof entry[f] === 'string')) {
        entries.push(entry);
      }
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

function serializeEntries(entries) {
  return entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '');
}

// Entries worth checking right now: old enough that a #668/#619-class
// revert would already have happened (minAgeMs), not so old that they're
// stale/no longer actionable (maxAgeMs). Malformed timestamps are excluded
// (can't reason about their age) rather than treated as always-due.
function selectEntriesInWindow(entries, { nowMs, minAgeMs, maxAgeMs }) {
  return entries.filter(e => {
    const tsMs = Date.parse(e.ts);
    if (!Number.isFinite(tsMs)) return false;
    const ageMs = nowMs - tsMs;
    return ageMs >= minAgeMs && ageMs <= maxAgeMs;
  });
}

// Entries worth keeping in the ledger going forward — drops anything past
// maxAgeMs (no longer useful to check) and anything with an unparseable
// timestamp (dead weight). Called by the scheduled checker so the hot push
// path (record-push-ledger.js) can stay a cheap append-only write.
function pruneToWindow(entries, { nowMs, maxAgeMs }) {
  return entries.filter(e => {
    const tsMs = Date.parse(e.ts);
    return Number.isFinite(tsMs) && (nowMs - tsMs) <= maxAgeMs;
  });
}

module.exports = {
  buildLedgerEntry,
  buildFailureEntry,
  isGithubActionsRunner,
  parseLedgerLines,
  serializeEntries,
  selectEntriesInWindow,
  pruneToWindow,
};
