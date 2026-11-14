const { holdsApprovedValue } = require('./approved-fix-writer-guards');

/**
 * An explicit per-file protection is a human decision, even without a byline.
 * So is an approved-fix plan that set this exact duplicateOf on this content
 * (BRO-7174): the url-mismatch audit --fix and the write-guard stale-pointer
 * self-heal both read this, and neither may undo an approved pointer.
 */
function isManuallyProtectedDuplicate(data) {
  return (Array.isArray(data.protectedFields) && data.protectedFields.includes('duplicateOf'))
    || holdsApprovedValue(data, 'duplicateOf');
}

module.exports = { isManuallyProtectedDuplicate };
