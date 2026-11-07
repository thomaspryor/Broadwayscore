/**
 * Write `content` to `filePath` only when it differs from what is already on
 * disk. Returns true when the file was written (new or changed), false when
 * the bytes were identical and the write was skipped.
 *
 * BRO-3108: llm-scoring's saveReviewFile() used to write unconditionally and
 * count every call in filesModified, so a run that re-serialised a review
 * file to identical bytes still read as productive to
 * scoring-progress-gate.js and dispatched a rebuild.
 */
const fs = require('fs');

function writeFileIfChanged(filePath, content, fsImpl = fs) {
  let existing = null;
  try {
    existing = fsImpl.readFileSync(filePath, 'utf-8');
  } catch (_) {
    existing = null; // missing/unreadable: write it
  }
  if (existing === content) return false;
  fsImpl.writeFileSync(filePath, content);
  return true;
}

module.exports = { writeFileIfChanged };
