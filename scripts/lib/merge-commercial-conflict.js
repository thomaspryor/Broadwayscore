#!/usr/bin/env node
/**
 * Helper invoked by push-with-retry.sh during conflict resolution on
 * data/commercial.json or data/commercial-pending-review.json.
 *
 * Usage:
 *   node scripts/lib/merge-commercial-conflict.js <file> <keep_local_flag> <keep_remote_flag>
 *
 * Where:
 *   <file>              path relative to repo root
 *   <keep_local_flag>   '--ours' or '--theirs' (mode-aware, set by caller)
 *   <keep_remote_flag>  the opposite
 *
 * Reads our + remote sides via `git checkout`, computes the per-slug merge,
 * writes the result, and exits 0 on success. On any error, exits non-zero so
 * the caller falls back to keep-local.
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const file = process.argv[2];
const keepLocal = process.argv[3];
const keepRemote = process.argv[4];
if (!file || !keepLocal || !keepRemote) {
  console.error('merge-commercial-conflict: missing args');
  process.exit(1);
}

const { mergeCommercialJson, mergePendingReview } = require('./merge-commercial-data');

function readSide(flag) {
  execSync(`git checkout ${flag} -- ${JSON.stringify(file)}`, { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

try {
  // Read both sides one at a time (git checkout overwrites the working copy).
  const localData = readSide(keepLocal);
  const remoteData = readSide(keepRemote);

  let mergedResult;
  if (file.endsWith('commercial-pending-review.json')) {
    mergedResult = mergePendingReview(localData, remoteData);
  } else {
    mergedResult = mergeCommercialJson(localData, remoteData);
  }

  fs.writeFileSync(file, JSON.stringify(mergedResult.merged, null, 2) + '\n');
  console.log(`merge-commercial-conflict: ${file} merged — ${JSON.stringify(mergedResult.stats)}`);
} catch (e) {
  console.error('merge-commercial-conflict FAILED:', e.message);
  process.exit(1);
}
