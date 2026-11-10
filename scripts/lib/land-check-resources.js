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

// BRO-7315: a TAP title line ("# Subtest: …", "ok 12 - …", "not ok 12 - …") names a test, and four tests
// ABOUT disk handling say ENOSPC in their names. Counting those made every land-local-check run end
// "not a valid verdict" (exit 3) since BRO-7186. Only output outside a title line counts.
const TAP_TITLE_RE = /^\s*(?:# Subtest:|(?:not )?ok \d+ - ).*$/gm;

/** True when the text shows the environment (disk) failed, not the code. */
function looksLikeEnvFailure(text) {
  return ENV_FAILURE_RE.test(String(text || '').replace(TAP_TITLE_RE, ''));
}

const RECENT_MS = 6 * 3600_000;

/** Raw gate logs (<gate>.log) under dirs that show ENOSPC -> list of file paths. */
function envFailureLogs(dirs, { readdir = require('fs').readdirSync, read = require('fs').readFileSync, path = require('path') } = {}) {
  const hits = [];
  for (const dir of dirs) {
    let names = [];
    try { names = readdir(dir); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.log'))) {
      try { if (looksLikeEnvFailure(read(path.join(dir, n), 'utf8'))) hits.push(path.join(dir, n)); } catch { /* unreadable: skip */ }
    }
  }
  return hits;
}

/**
 * Was land ref `ref` already landed on main although the ref is gone and the
 * run lookup by name found nothing? Only a landings-ledger row naming this exact
 * branch within 6h counts (a BRO id in a commit subject does not: cards land
 * more than once, and reverts / follow-ups cite the same id).
 * run: the latest land run found for the ref, or null; a red/cancelled run
 * means the ref was refused, never landed. -> { landed, sha?, tip?, via? }
 */
function landedOnMain({ ref, ledgerRows = [], run = null, nowMs = Date.now() }) {
  if (run && run.conclusion && run.conclusion !== 'success') return { landed: false };
  const rows = ledgerRows
    .filter((r) => r && r.branch === ref && r.sha && r.ts && nowMs - Date.parse(r.ts) < RECENT_MS)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  if (!rows.length) return { landed: false };
  const row = rows[rows.length - 1];
  return { landed: true, sha: row.sha, tip: row.tip || null, via: 'landings ledger' };
}

/** Parse `git log --format=%H%x09%cI%x09%s` output -> [{sha, ts, subject}] */
function parseMainLog(text) {
  return String(text || '').split('\n').filter(Boolean).map((l) => {
    const [sha, ts, ...subj] = l.split('\t');
    return { sha, ts, subject: subj.join('\t') };
  });
}

module.exports = { envFailureLogs, parseMainLog, MIN_FREE_BYTES, lowDiskMessage, freeBytesOf, looksLikeEnvFailure, landedOnMain };
