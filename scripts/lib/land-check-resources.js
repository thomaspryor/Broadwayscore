'use strict';
/**
 * land-check-resources.js — pure decisions for land tooling that must not report
 * false results (BRO-7186). Required by land-local-check.js and wait-for-land.js;
 * tested via require() in land-local-check.test.mjs.
 */

const MIN_FREE_BYTES = 3 * 1024 ** 3;
const ENV_FAILURE_RE = /\bENOSPC\b|no space left on device/i;

/** -> null when there is room, else the refusal message (land-local-check exit 3). */
function lowDiskMessage(freeBytes, { minBytes = MIN_FREE_BYTES, when = 'before the run' } = {}) {
  if (!Number.isFinite(freeBytes)) return null; // unreadable: do not block on a guess
  if (freeBytes >= minBytes) return null;
  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  return `land-local-check: only ${gb(freeBytes)} GB free ${when} (need ${gb(minBytes)} GB). A full disk makes tests fail with ENOSPC on the branch run, which reads as new failures (BRO-7186: 379 false ones). Free space first (remove old worktrees / node_modules / npm cache), then re-run. Not judging.`;
}

/** Free bytes on the filesystem holding dir, or NaN. */
function freeBytesOf(dir, statfs = require('fs').statfsSync) {
  try { const s = statfs(dir); return Number(s.bavail) * Number(s.bsize); } catch { return NaN; }
}

/** True when the text shows the environment (disk) failed, not the code. */
function looksLikeEnvFailure(text) {
  return ENV_FAILURE_RE.test(String(text || ''));
}

const RECENT_MS = 6 * 3600_000;

/**
 * Was land ref `ref` already landed on main although the ref is gone and no run
 * was found by name? ledgerRows: parsed landings.jsonl rows ({branch, sha, ts});
 * mainCommits: [{sha, subject, ts?}] recent origin/main commits (train riders get
 * no ledger row, and land.yml rebases so the pushed sha is not on main).
 * -> { landed: true, sha, via } | { landed: false }
 */
function landedOnMain({ ref, ledgerRows = [], mainCommits = [], nowMs = Date.now() }) {
  const rows = ledgerRows
    .filter((r) => r && r.branch === ref && r.sha && (!r.ts || nowMs - Date.parse(r.ts) < RECENT_MS))
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (rows.length) return { landed: true, sha: rows[rows.length - 1].sha, via: 'landings ledger' };
  const bro = /\bbro-(\d{3,6})\b/i.exec(ref);
  if (bro) {
    const re = new RegExp(`\\bBRO-${bro[1]}\\b`, 'i');
    const hit = mainCommits.find((c) => re.test(c.subject || '') && (!c.ts || nowMs - Date.parse(c.ts) < RECENT_MS));
    if (hit) return { landed: true, sha: hit.sha, via: `main commit naming BRO-${bro[1]}` };
  }
  return { landed: false };
}

/** Parse `git log --format=%H%x09%cI%x09%s` output -> [{sha, ts, subject}] */
function parseMainLog(text) {
  return String(text || '').split('\n').filter(Boolean).map((l) => {
    const [sha, ts, ...subj] = l.split('\t');
    return { sha, ts, subject: subj.join('\t') };
  });
}

module.exports = { parseMainLog, MIN_FREE_BYTES, lowDiskMessage, freeBytesOf, looksLikeEnvFailure, landedOnMain };
