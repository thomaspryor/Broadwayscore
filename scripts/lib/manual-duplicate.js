/** An explicit per-file protection is a human decision, even without a byline. */
function isManuallyProtectedDuplicate(data) {
  return Array.isArray(data.protectedFields) && data.protectedFields.includes('duplicateOf');
}

module.exports = { isManuallyProtectedDuplicate };
