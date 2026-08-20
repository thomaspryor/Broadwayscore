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

const { findEntry } = require('./core-data-merge-registry');
const { mergeCommercialJson } = require('./merge-commercial-data');

function readSide(flag) {
  execSync(`git checkout ${flag} -- ${JSON.stringify(file)}`, { stdio: 'pipe' });
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

try {
  // Read both sides one at a time (git checkout overwrites the working copy).
  const localData = readSide(keepLocal);
  const remoteData = readSide(keepRemote);

  // BRO-76: merge-fn dispatch now reads from the canonical registry
  // (scripts/lib/core-data-merge-registry.js) instead of a hand-maintained
  // if/else endsWith chain — one fewer place a new multi-writer file's merge
  // fn has to be independently remembered. Unmatched paths (there are none
  // among this script's callers today — push-with-retry.sh only invokes it
  // for case arms it already recognizes) fall back to mergeCommercialJson,
  // preserving this script's pre-existing default behavior.
  const entry = findEntry(file, 'public-repo');
  const merge = entry ? entry.merge : mergeCommercialJson;
  // diary-shows.json is written by its three producers without a trailing
  // newline; match that so a no-op merge is byte-identical.
  const trailingNewline = entry ? entry.newline !== false : true;

  const mergedResult = merge(localData, remoteData);

  fs.writeFileSync(file, JSON.stringify(mergedResult.merged, null, 2) + (trailingNewline ? '\n' : ''));
  console.log(`merge-commercial-conflict: ${file} merged — ${JSON.stringify(mergedResult.stats)}`);
} catch (e) {
  console.error('merge-commercial-conflict FAILED:', e.message);
  process.exit(1);
}
