/**
 * persist-review-snapshot.js
 *
 * BRO-3168: recover-explicit-ratings.js reads every candidate file up front,
 * spends minutes on network/LLM work, then wrote its whole in-memory copy
 * back. A correction another writer made in between (a person's
 * originalScoreCleared, a refresh run) was silently overwritten.
 *
 * mergeOntoDisk is a three-way merge: the caller's own edits (data vs the
 * snapshot it read) are applied over the CURRENT disk record, and every field
 * the caller did not touch keeps disk's value. One rule outranks the caller:
 * an originalScoreCleared that appeared on disk since the snapshot means a
 * person (or fix script) cleared the star score, so the caller's recovered
 * score fields are dropped and disk's are kept (BRO-3171 regression class).
 */
const fs = require('fs');
const path = require('path');
const { approvedUrlFixListingReason } = require('./approved-url-fix');

// Enumerable so {...data} carries the baseline through collector updates.
// Symbols never appear in JSON, including the on-disk review record.
const READ_SNAPSHOT = Symbol('review read snapshot');

function readReviewForUpdate(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  data[READ_SNAPSHOT] = { filePath: path.resolve(filePath), data: _clone(data) };
  return data;
}

// Fields a score recovery writes (setExtractedScore + recover-explicit-ratings).
const RECOVERED_SCORE_FIELDS = [
  'originalScore', 'originalScoreNormalized', 'originalScoreSource',
  'scoreSource', 'scoreExtractedFrom', 'scoreRecoveredAt',
];

// The clear itself and the breadcrumb a retirement writes in its place.
const CLEAR_FIELDS = [
  'originalScoreCleared', 'originalScoreClearedReason',
  'originalScoreClearSupersededBy', 'originalScoreClearSupersededReason', 'originalScoreClearSupersededAt',
];

const _same =(a, b) => JSON.stringify(a) === JSON.stringify(b);
const _clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * @param {object} snapshot what the caller read
 * @param {object} data     the caller's edited copy
 * @param {object|null} disk the record on disk now (null: absent/unreadable)
 * @returns {{merged: object, droppedScore: boolean, droppedUrl?: boolean, keptDiskFields: string[]}}
 */
function mergeOntoDisk(snapshot, data, disk) {
  if (!disk) return { merged: _clone(data), droppedScore: false, keptDiskFields: [] };
  const merged = _clone(disk);
  const keptDiskFields = [];
  const keys = new Set([...Object.keys(snapshot || {}), ...Object.keys(data || {})]);
  for (const key of keys) {
    const mine = data[key];
    if (_same(mine, snapshot[key])) {
      if (!_same(disk[key], snapshot[key])) keptDiskFields.push(key);
      continue; // caller did not touch it: disk's value stands
    }
    if (mine === undefined) delete merged[key];
    else merged[key] = _clone(mine);
  }
  // Phase 0 SERP recovery bypasses createOrMergeReviewFile. Check CURRENT
  // disk approvals too, since a fix can land while discovery is in flight.
  // Reject the whole candidate snapshot: its body/score may describe the
  // refused listing. The caller is rebased onto disk before later phases.
  if (merged.url !== disk.url && approvedUrlFixListingReason(disk, merged.url)) {
    return { merged: _clone(disk), droppedScore: false, droppedUrl: true, keptDiskFields };
  }
  // A clear on disk wins over the caller's score edits: whether it appeared
  // since the snapshot, was re-made for another reason, or was already in the
  // baseline (an earlier write this run picked it up). Only the caller's
  // retirement of that exact clear (a structural star, BRO-3171) lifts it.
  const retiredThisClear = data.originalScoreCleared !== true
    && typeof data.originalScoreClearSupersededBy === 'string'
    && snapshot.originalScoreCleared === true
    && _same(disk.originalScoreClearedReason, snapshot.originalScoreClearedReason);
  const diskClearStands = disk.originalScoreCleared === true && !retiredThisClear;
  let droppedScore = false;
  if (diskClearStands) {
    for (const key of CLEAR_FIELDS) {
      if (disk[key] === undefined) delete merged[key];
      else merged[key] = _clone(disk[key]);
    }
    for (const key of RECOVERED_SCORE_FIELDS) {
      if (_same(merged[key], disk[key])) continue;
      droppedScore = true;
      if (disk[key] === undefined) delete merged[key];
      else merged[key] = _clone(disk[key]);
    }
  }
  return { merged, droppedScore, keptDiskFields };
}

/**
 * Re-read filePath, merge the caller's edits onto it, write it. Updates
 * review.data and review.snapshot to what was written, so a later write in
 * the same run diffs against the new baseline.
 * Use readReviewForUpdate() for data, or supply an explicit read-time snapshot.
 * @param {{filePath:string, data:object, snapshot?:object, trailingNewline?:boolean}} review
 */
function prepareReviewSnapshot(review, log) {
  const read = review.data[READ_SNAPSHOT];
  if (read && read.filePath !== path.resolve(review.filePath)) {
    throw new Error('Review snapshot belongs to a different file; persist before renaming');
  }
  const snapshot = review.snapshot || (read && read.data);
  if (!snapshot) throw new Error('Review write requires a snapshot captured before editing');
  let disk = null;
  try { disk = JSON.parse(fs.readFileSync(review.filePath, 'utf8')); } catch { /* absent or unreadable */ }
  const { merged, droppedScore, droppedUrl, keptDiskFields } = mergeOntoDisk(snapshot, review.data, disk);
  if (droppedUrl) {
    log(`    [persist] ${review.filePath}: listing URL would undo an approved URL fix; candidate snapshot not written (BRO-5693)`);
  }
  if (droppedScore) {
    log(`    [persist] ${review.filePath}: originalScoreCleared set on disk since read; recovered score not written (BRO-3168)`);
  }
  if (keptDiskFields.length) {
    log(`    [persist] ${review.filePath}: kept concurrent on-disk change to ${keptDiskFields.join(', ')}`);
  }
  return { merged, droppedScore, droppedUrl: !!droppedUrl, keptDiskFields };
}

function adoptSnapshot(review, merged) {
  const carriesSnapshot = !!review.data[READ_SNAPSHOT];
  // In place: callers may hold a reference to review.data.
  for (const key of Object.keys(review.data)) if (!(key in merged)) delete review.data[key];
  Object.assign(review.data, merged);
  review.snapshot = _clone(merged);
  if (carriesSnapshot) review.data[READ_SNAPSHOT] = { filePath: path.resolve(review.filePath), data: _clone(merged) };
}

function persistReviewSnapshot(review, log = console.log) {
  const { merged, ...result } = prepareReviewSnapshot(review, log);
  fs.writeFileSync(review.filePath, JSON.stringify(merged, null, 2) + (review.trailingNewline ? '\n' : ''));
  adoptSnapshot(review, merged);
  return result;
}

// The collector can identify the byline midway through an update. Merge at
// the source before the guarded rename, then carry the new path's baseline
// into the collector's trailing write. A refused rename changes nothing.
function renameReviewSnapshot(review, newPath, options = {}, log = console.log) {
  const { merged } = prepareReviewSnapshot(review, log);
  const result = require('./review-write-guard').safeRenameReview(review.filePath, newPath, { ...options, newData: merged });
  if (result.wrote) {
    review.filePath = newPath;
    adoptSnapshot(review, readReviewForUpdate(newPath));
  }
  return result;
}

module.exports = { readReviewForUpdate, renameReviewSnapshot, mergeOntoDisk, persistReviewSnapshot, RECOVERED_SCORE_FIELDS };
