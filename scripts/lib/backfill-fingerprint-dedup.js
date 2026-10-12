'use strict';

const { wouldFormDuplicateCycle } = require('./duplicate-cycle');

/** Apply the backfill's fingerprint owner without undoing an existing dedupe.
 * The first matching file can already point at this file via either duplicate
 * field. Following it would restore a canonical backpointer on every weekly
 * run (BRO-4188). Keep reviewed clears and refuse cycles of any length.
 */
function applyFingerprintDuplicate(data, file, owner, loadSibling) {
  if (data.duplicateTextOfCleared || data._duplicateOfCleared) {
    return { changed: false, target: null };
  }
  if (owner && owner !== file) {
    if (wouldFormDuplicateCycle(file, owner, loadSibling)) {
      return { changed: false, target: null };
    }
    const changed = data.duplicateTextOf !== owner;
    data.duplicateTextOf = owner;
    return { changed, target: owner };
  }
  const changed = !!data.duplicateTextOf;
  if (changed) delete data.duplicateTextOf;
  return { changed, target: null };
}

module.exports = { applyFingerprintDuplicate };
