#!/usr/bin/env node
/**
 * Helper invoked by push-with-retry.sh during conflict resolution on
 * data/commercial.json, data/commercial-pending-review.json,
 * data/commercial-research-queue.json, data/diary-shows.json,
 * data/social-post-history.json, or data/audit/feedback-request-ledger.json.
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

const { mergeCommercialJson, mergePendingReview, mergeResearchQueue } = require('./merge-commercial-data');
const { mergeDiaryShows } = require('./merge-diary-shows');
const { mergeSocialPostHistory } = require('./merge-social-post-history');
const { mergeFeedbackLedger } = require('./merge-feedback-ledger');

function readSide(flag) {
  execSync(`git checkout ${flag} -- ${JSON.stringify(file)}`, { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

try {
  // Read both sides one at a time (git checkout overwrites the working copy).
  const localData = readSide(keepLocal);
  const remoteData = readSide(keepRemote);

  let mergedResult;
  let trailingNewline = true;
  if (file.endsWith('commercial-pending-review.json')) {
    mergedResult = mergePendingReview(localData, remoteData);
  } else if (file.endsWith('commercial-research-queue.json')) {
    mergedResult = mergeResearchQueue(localData, remoteData);
  } else if (file.endsWith('diary-shows.json')) {
    mergedResult = mergeDiaryShows(localData, remoteData);
    // diary-shows.json is written by its three producers without a trailing
    // newline; match that so a no-op merge is byte-identical.
    trailingNewline = false;
  } else if (file.endsWith('social-post-history.json')) {
    mergedResult = mergeSocialPostHistory(localData, remoteData);
  } else if (file.endsWith('feedback-request-ledger.json')) {
    mergedResult = mergeFeedbackLedger(localData, remoteData);
  } else {
    mergedResult = mergeCommercialJson(localData, remoteData);
  }

  fs.writeFileSync(file, JSON.stringify(mergedResult.merged, null, 2) + (trailingNewline ? '\n' : ''));
  console.log(`merge-commercial-conflict: ${file} merged — ${JSON.stringify(mergedResult.stats)}`);
} catch (e) {
  console.error('merge-commercial-conflict FAILED:', e.message);
  process.exit(1);
}
