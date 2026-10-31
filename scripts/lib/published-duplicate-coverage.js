'use strict';

const fs = require('fs');
const path = require('path');
const { computeContentFingerprint } = require('./content-quality');

/**
 * Mirrors only the conservative core of the rebuild's duplicate ladder (duplicate-of-exclusion.js): the
 * pointer target is published, does not point back (a circular pair keeps one side by its own tiebreak,
 * the JCS 2026-07-09 class), is not itself a copy, and for duplicateTextOf the text still matches (a
 * mismatch is a stale flag the rebuild recovers). Anything unclear stays reported as hidden.
 */
function isCoveredByPublishedDuplicate(data, file, dirPath, entryKeys) {
  const readTarget = (t) => {
    if (typeof t !== 'string' || t === file || !entryKeys.has(t)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(dirPath, t), 'utf8')); } catch { return null; }
  };
  const pointsBack = (ref) => ref.duplicateOf === file || ref.duplicateTextOf === file;
  const selfRef = data.duplicateOf === file || data.duplicateTextOf === file;
  if (selfRef) return false;
  const byOf = readTarget(data.duplicateOf);
  if (byOf && !byOf.duplicateOf && !pointsBack(byOf)) return true;
  const byText = readTarget(data.duplicateTextOf);
  if (byText && !pointsBack(byText) && data.fullText && byText.fullText) {
    const a = computeContentFingerprint(data.fullText);
    const b = computeContentFingerprint(byText.fullText);
    return Boolean(a && b && a === b);
  }
  return false;
}

module.exports = { isCoveredByPublishedDuplicate };
