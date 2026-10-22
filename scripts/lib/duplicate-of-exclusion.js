'use strict';

const fs = require('fs');
const path = require('path');
const { computeContentFingerprint } = require('./content-quality');
const { findDuplicateOfCycle, resolveCycleTiebreak } = require('./duplicate-cycle');

/**
 * The rebuild's duplicateOf gate, shared with scoring-delta's replay.
 * Reference eligibility and flag inheritance use the caller's guard version.
 * Sibling reads stay local to the supplied filePath (including replay snapshots).
 */
function duplicateOfExclusion(data, filePath, { readSibling, fileCount, referenceExcluded, inheritedFlag }) {
  if (!data.duplicateOf) return { reason: null };
  if (!filePath || !data.duplicateOf.endsWith('.json')) return { reason: 'skippedDuplicateOf' };
  const showDir = path.dirname(filePath);
  const file = path.basename(filePath);
  const read = readSibling || (name => {
    try { return JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf8')); } catch { return null; }
  });
  let refAlsoDupe = false, refExcluded = false, refInheritedFlag = null;
  let isCircular = false, circularSameText = false, nCycleExclude = false;
  try {
    // The rebuild reads the immediate reference fresh; only the cycle walk
    // uses its memoized sibling reader (earlier files can write corrections).
    const ref = JSON.parse(fs.readFileSync(path.join(showDir, data.duplicateOf), 'utf8'));
    refAlsoDupe = !!ref.duplicateOf;
    isCircular = ref.duplicateOf === file || ref.duplicateTextOf === file;
    const sameUrl = !!(data.url && ref.url && data.url === ref.url);
    if (isCircular && data.fullText && ref.fullText) {
      const a = computeContentFingerprint(data.fullText), b = computeContentFingerprint(ref.fullText);
      circularSameText = !!(a && b && a === b) || sameUrl;
    } else if (isCircular && sameUrl) {
      circularSameText = true;
    }
    if (!isCircular) {
      const walk = findDuplicateOfCycle(file, read, fileCount ?? fs.readdirSync(showDir).length);
      if (walk.cycleFound) {
        const members = walk.chain.slice(0, -1);
        const tie = resolveCycleTiebreak(members, name => name === file ? data : read(name), computeContentFingerprint);
        nCycleExclude = tie.sameText && file !== tie.survivor;
      }
    }
    const refPath = path.join(showDir, data.duplicateOf);
    refExcluded = referenceExcluded(ref, refPath);
    refInheritedFlag = inheritedFlag(data, ref, refPath);
  } catch {
    refAlsoDupe = true; // Missing/corrupt reference: recover the stale pointer.
  }
  let reason = null;
  if (!refAlsoDupe && !refExcluded) reason = 'skippedDuplicateOf';
  else if (refInheritedFlag && !(isCircular && !circularSameText)) reason = 'skippedDuplicateOfInheritedFlag';
  else if (!refExcluded && ((isCircular && circularSameText && file > data.duplicateOf) || nCycleExclude)) reason = 'skippedCircularDuplicateTiebreak';
  return { reason, refExcluded, inheritedReason: refInheritedFlag, recovered: reason === null };
}

module.exports = { duplicateOfExclusion };
