/**
 * push-ledger.js — pure functions for the CI-side push ledger (task #677).
 *
 * push-with-retry.sh runs on ephemeral GitHub Actions runners: it cannot
 * spawn a background process that survives past job completion the way
 * merge-worktree-to-main.sh's local-session mitigation does (task #668,
 * scripts/verify-merge-landed.js). So the CI-side mitigation instead
 * durably records {sha, branch, ts, workflow} for every successful push to
 * data/audit/recent-pushes.jsonl (scripts/record-push-ledger.js appends one
 * line per push, committed+pushed on its own — see that file for why), and
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

function buildLedgerEntry({ sha, branch, ts, workflow, runId, runAttempt }) {
  if (!sha) throw new Error('buildLedgerEntry: sha is required');
  return JSON.stringify({
    sha,
    branch: branch || 'main',
    ts: ts || new Date().toISOString(),
    workflow: workflow || '',
    runId: runId || '',
    runAttempt: runAttempt || '',
  });
}

// Parses JSONL content into entries, silently skipping blank/malformed lines
// (a single corrupted line — e.g. a partial write from a killed runner —
// must never take down the whole ledger).
function parseLedgerLines(content) {
  if (!content) return [];
  const entries = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry.sha === 'string' && typeof entry.ts === 'string') {
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
  parseLedgerLines,
  serializeEntries,
  selectEntriesInWindow,
  pruneToWindow,
};
