#!/usr/bin/env node
'use strict';
/**
 * Conflict merge for broadway-review-texts `_pending/<show>/<outlet>--<hash>.json`
 * stubs (BRO-5716).
 *
 * Two concurrent opening-night-poller runs can each discover the SAME review
 * and write the same pending stub path with different metadata (firstSeenAt,
 * source). Both runs usually also drain the same older stub, so git's rename
 * detection pairs the drained file with the new one and reports rename/delete
 * on the new path. That is a structural conflict `-X theirs` cannot settle,
 * both sides hold the path (so it is not modify/delete), and the generic
 * resolve_conflicts arm refuses to discard our differing blob (task #619).
 * Every rebase/merge/cherry-pick attempt then fails and the run loses all of
 * its new review files (run 39292955319: 20/20 push attempts, 11 files).
 *
 * Both stubs describe one review, so a field merge loses nothing real:
 * remote's non-null fields win, nulls are filled from ours, firstSeenAt keeps
 * the earliest time, fullText keeps the longer text. Stubs for different
 * reviews (url/showId/outletId differ) throw, and the caller leaves the
 * conflict unresolved exactly as before.
 *
 * CLI (called by push-with-retry.sh resolve_conflicts, mode-aware flags):
 *   node scripts/lib/merge-pending-stub.js <file> <keep_local_flag> <keep_remote_flag>
 * Exit 0 = merged and written; non-zero = could not merge (leave unresolved).
 */

const IDENTITY_FIELDS = ['url', 'showId', 'outletId'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergePendingStubs(local, remote) {
  if (!isPlainObject(local) || !isPlainObject(remote)) {
    throw new Error('pending stub sides must both be JSON objects');
  }
  for (const f of IDENTITY_FIELDS) {
    if (local[f] !== remote[f]) {
      throw new Error(`pending stubs differ on ${f} (${JSON.stringify(local[f])} vs ${JSON.stringify(remote[f])}), not the same review`);
    }
  }
  const merged = { ...remote };
  const filled = [];
  for (const [k, v] of Object.entries(local)) {
    if ((merged[k] === null || merged[k] === undefined) && v !== null && v !== undefined) {
      merged[k] = v;
      filled.push(k);
    }
  }
  if (typeof local.firstSeenAt === 'string' && typeof remote.firstSeenAt === 'string') {
    const l = Date.parse(local.firstSeenAt);
    const r = Date.parse(remote.firstSeenAt);
    if (Number.isFinite(l) && Number.isFinite(r) && l < r) merged.firstSeenAt = local.firstSeenAt;
  }
  if (typeof local.fullText === 'string' && typeof remote.fullText === 'string'
      && local.fullText.length > remote.fullText.length) {
    merged.fullText = local.fullText;
  }
  // Logged so any local value the merge dropped is visible in the run log.
  const remoteWon = Object.keys(local).filter((k) => local[k] !== null && local[k] !== undefined
    && JSON.stringify(local[k]) !== JSON.stringify(merged[k]));
  return { merged, stats: { filledFromLocal: filled, remoteWon } };
}

function main(argv) {
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const [file, keepLocal, keepRemote] = argv;
  if (!file || !keepLocal || !keepRemote) {
    console.error('merge-pending-stub: usage <file> <keep_local_flag> <keep_remote_flag>');
    return 1;
  }
  const readSide = (flag) => {
    execFileSync('git', ['checkout', flag, '--', file], { stdio: 'pipe' });
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  try {
    const local = readSide(keepLocal);
    const remote = readSide(keepRemote);
    const { merged, stats } = mergePendingStubs(local, remote);
    // Poller writes these with JSON.stringify(obj, null, 2) and no trailing newline.
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
    console.log(`merge-pending-stub: ${file} merged ${JSON.stringify(stats)}`);
    return 0;
  } catch (e) {
    console.error(`merge-pending-stub FAILED for ${file}: ${e.message}`);
    return 1;
  }
}

module.exports = { mergePendingStubs };

if (require.main === module) process.exit(main(process.argv.slice(2)));
