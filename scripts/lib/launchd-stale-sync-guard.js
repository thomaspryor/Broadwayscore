/**
 * launchd-stale-sync-guard.js — detect the "swallowed git sync failure"
 * pattern that let launchd jobs silently run stale code whenever
 * data/audit/* had local edits (BRO-1794, task #732).
 *
 * The bug shape: `git (pull|merge) ... (--ff-only|--rebase) ... || (echo|true)`
 * on one line. The `||` turns a failed sync into a no-op instead of an
 * abort, and the only trace is an easily-missed log line (or none at all
 * for `|| true`). scripts/lib/sync-audit-checkout.sh is the sanctioned
 * replacement — it resets regenerable data/audit/ snapshots, retries, and
 * exits non-zero (fails loud) if it still can't recover. This guard exists
 * so the NEXT script that copies the old one-liner instead of calling that
 * helper gets caught by a test, not by a launchd log nobody reads (the
 * exact way weekly-retro.sh's copy went unnoticed through the 2026-08-02
 * sweep that fixed the other four jobs).
 *
 * Pure function, no fs — scripts/audit-launchd-stale-sync-guard.js does the
 * file walking. Line-based on purpose: every real instance found in this
 * repo (autonomous-shadow's old plist, weekly-retro.sh, sync-review-
 * texts.sh, simulate-opening-night-full.sh, sync-memory-to-repo.sh,
 * refresh-drafts.sh) is a single physical line, and a full shell parser is
 * more machinery than a lint guard needs. Skips comment lines so plist
 * headers that quote the bad pattern as documentation (e.g.
 * predispatch-queue-audit.plist's own "Task #1563" comment) don't
 * self-flag.
 */

'use strict';

const GIT_SYNC_RE = /\bgit\s+(?:-C\s+\S+\s+)?(?:pull|merge)\b[^\n|]*(?:--ff-only|--rebase)\b/;
const SWALLOW_RE = /\|\|\s*(?:echo\b|true\b)/;

// Waiver escape hatch (second-opinion design finding, BRO-1794): this is a
// brand-new heuristic that hasn't run against arbitrary future edits, and
// SWALLOW_RE can't distinguish a real silent-continue from a deliberately
// loud one-liner like `|| { echo "reason"; exit 1; }` that just happens to
// start with `echo`. Same convention as this file's `unbounded-fetch-ok:`
// siblings (scripts/lib/sync-audit-checkout.sh, scripts/notion-action-poll.js):
// a same-line trailing comment naming the reason waives that one line.
const WAIVER_RE = /launchd-stale-sync-ok:/;

function findUnsafeSyncPatterns(text) {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (WAIVER_RE.test(line)) continue;
    if (GIT_SYNC_RE.test(line) && SWALLOW_RE.test(line)) {
      findings.push({ line: i + 1, text: trimmed });
    }
  }
  return findings;
}

// For .plist files: only scan the literal <string> ProgramArguments
// content, never the XML comment blocks that document the OLD pattern.
const PLIST_STRING_RE = /<string>(.*)<\/string>/g;

function findUnsafeSyncPatternsInPlist(text) {
  const findings = [];
  let match;
  while ((match = PLIST_STRING_RE.exec(text)) !== null) {
    const decoded = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (WAIVER_RE.test(decoded)) continue;
    if (GIT_SYNC_RE.test(decoded) && SWALLOW_RE.test(decoded)) {
      findings.push({ line: null, text: decoded.trim() });
    }
  }
  return findings;
}

module.exports = { findUnsafeSyncPatterns, findUnsafeSyncPatternsInPlist };
