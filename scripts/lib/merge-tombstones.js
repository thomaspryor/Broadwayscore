/**
 * Durable audit rows for reviews the merge reconciler deletes (BRO-2918).
 * mergeReviewsJson returns unknownBylineFossilsDroppedKeys only in its stats,
 * which the driver prints to CI stderr; if a deletion is ever wrong the only
 * evidence was a log line. This turns those keys into appendable JSONL rows.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// One file per run (unique name), never an append-to-shared-file: the push
// action rebases with `-X ours`, so two racing runs appending to one JSONL
// would conflict and silently drop the remote's rows.
const TOMBSTONE_DIR = 'review-merge-tombstones';

function buildTombstoneRows(sourceFile, stats, now = new Date()) {
  const keys = [
    ...((stats && stats.unknownBylineFossilsDroppedKeys) || []).map((k) => ({ ...k, reason: 'unknown-byline-fossil' })),
    // BRO-4852: remote-only rows our rebuild excluded (three-way rule).
    ...((stats && stats.droppedByOursKeys) || []).map((k) => ({ ...k, reason: 'excluded-by-our-rebuild' })),
  ];
  return keys.map((k) => ({
    at: now.toISOString(),
    file: sourceFile,
    reason: k.reason,
    showId: k.showId,
    outlet: k.outlet,
    criticName: k.criticName,
    url: k.url,
    supersededBy: k.supersededBy,
    // An attempted reconciliation, not proof the row is absent from the final
    // pushed state (the push action retries); run/attempt let a reader order them.
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
  }));
}

/**
 * Writes rows to a file under dir; returns its relative path, or null if no rows.
 * In CI the name is fixed per run + attempt + source file, so the push action's
 * retry loop (which re-runs the reconcile and drops the same rows again)
 * overwrites one file instead of leaving one duplicate file per attempt
 * (BRO-4852 ship-check). Different runs still never share a file.
 */
function writeTombstones(dir, rows, now = new Date(), env = process.env) {
  if (!rows.length) return null;
  fs.mkdirSync(dir, { recursive: true });
  const runKey = env.GITHUB_RUN_ID
    ? `run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || 1}-${path.basename(String(rows[0].file || 'merge'), '.json')}`
    : null;
  const name = runKey
    ? `${runKey}.jsonl`
    : `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.jsonl`;
  const rel = path.join(dir, name);
  fs.writeFileSync(rel, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: runKey ? 'w' : 'wx' });
  return rel;
}

module.exports = { TOMBSTONE_DIR, buildTombstoneRows, writeTombstones };
