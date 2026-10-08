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

/** Writes rows to a new unique file under dir; returns its relative path, or null if no rows. */
function writeTombstones(dir, rows, now = new Date()) {
  if (!rows.length) return null;
  fs.mkdirSync(dir, { recursive: true });
  const name = `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}.jsonl`;
  const rel = path.join(dir, name);
  fs.writeFileSync(rel, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { flag: 'wx' });
  return rel;
}

module.exports = { TOMBSTONE_DIR, buildTombstoneRows, writeTombstones };
