'use strict';

const fs = require('fs');
const path = require('path');
const { computeContentFingerprint } = require('./content-quality');
const { cycleTiebreakFor } = require('./duplicate-cycle');

/**
 * The rebuild's duplicateOf gate, shared with scoring-delta's replay.
 * Reference eligibility and flag inheritance use the caller's guard version.
 * referenceIsCopy(ref, refPath, data) says the excluded reference is itself a copy (BRO-5909).
 * Sibling reads stay local to the supplied filePath (including replay snapshots).
 */
function duplicateOfExclusion(data, filePath, { readSibling, fileCount, referenceExcluded, referenceIsCopy, inheritedFlag }) {
  if (!data.duplicateOf) return { reason: null };
  if (!filePath || !data.duplicateOf.endsWith('.json')) return { reason: 'skippedDuplicateOf' };
  const showDir = path.dirname(filePath);
  const file = path.basename(filePath);
  const read = readSibling || (name => {
    try { return JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf8')); } catch { return null; }
  });
  let refAlsoDupe = false, refExcluded = false, refInheritedFlag = null, refIsCopy = false;
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
      nCycleExclude = cycleTiebreakFor(file, data, read, fileCount ?? fs.readdirSync(showDir).length, computeContentFingerprint).exclude;
    }
    const refPath = path.join(showDir, data.duplicateOf);
    refExcluded = referenceExcluded(ref, refPath);
    refInheritedFlag = inheritedFlag(data, ref, refPath);
    // BRO-5909: a reference excluded as a copy of another review (syndicated,
    // cross-outlet, personal repost) must not recover this copy, or the
    // original ships twice. A circular pair keeps its own tiebreak.
    if (refExcluded && !refAlsoDupe && !isCircular && referenceIsCopy) refIsCopy = !!referenceIsCopy(ref, refPath, data);
  } catch {
    refAlsoDupe = true; // Missing/corrupt reference: recover the stale pointer.
  }
  let reason = null;
  if (!refAlsoDupe && !refExcluded) reason = 'skippedDuplicateOf';
  else if (refInheritedFlag && !(isCircular && !circularSameText)) reason = 'skippedDuplicateOfInheritedFlag';
  else if (refIsCopy) reason = 'skippedDuplicateOf';
  else if (!refExcluded && ((isCircular && circularSameText && file > data.duplicateOf) || nCycleExclude)) reason = 'skippedCircularDuplicateTiebreak';
  return { reason, refExcluded, inheritedReason: refInheritedFlag, recovered: reason === null };
}

/**
 * The rebuild's duplicateTextOf decision ladder (BRO-5907), given the facts the
 * rebuild gathered about this file and its reference. Returns the exclusion
 * reason, or null to let the file through.
 *  - staleFlag: texts no longer match (or this copy lost its text) → through.
 *  - a plain one-way duplicate of an includable, non-duplicate reference → skippedDuplicateText.
 *  - a same-text cycle, one-hop (isCircular) or longer (nCycle), keeps exactly
 *    one member: the rest get skippedCircularDuplicateTiebreak. Before BRO-5907
 *    the longer cycle fell into the plain-duplicate branch for every member.
 * @param {{staleFlag:boolean, refAlsoDupe:boolean, refExcluded:boolean, isCircular:boolean,
 *   circularSameText:boolean, refInheritedFlag:string|null, file:string, target:string,
 *   nCycle:{inCycle:boolean, sameText:boolean, exclude:boolean}|null}} f   nCycle from cycleTiebreakFor
 * @returns {null|'skippedDuplicateText'|'skippedDuplicateTextInheritedFlag'|'skippedCircularDuplicateTiebreak'}
 */
function duplicateTextOfDecision(f) {
  if (f.staleFlag) return null;
  const nCycle = f.nCycle && f.nCycle.inCycle ? f.nCycle : null; // a tail stays a plain duplicate
  const inSameTextCycle = (f.isCircular && f.circularSameText) || !!(nCycle && nCycle.sameText);
  if (!f.refAlsoDupe && !f.refExcluded && !inSameTextCycle) return 'skippedDuplicateText';
  if (f.refInheritedFlag && !(f.isCircular && !f.circularSameText)) return 'skippedDuplicateTextInheritedFlag';
  if (!f.refExcluded && f.isCircular && f.circularSameText && f.file > f.target) return 'skippedCircularDuplicateTiebreak';
  if (!f.refExcluded && !f.isCircular && nCycle && nCycle.exclude) return 'skippedCircularDuplicateTiebreak';
  return null;
}

module.exports = { duplicateOfExclusion, duplicateTextOfDecision };
