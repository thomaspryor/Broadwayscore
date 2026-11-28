const { canonicalArticleKey, normalizeOutlet } = require('./review-normalization');
const { isCrossOutletSyndicationPair, isRenameCollisionPair } = require('./syndication-pairs');
const { isManuallyProtectedDuplicate } = require('./manual-duplicate');
const { safeWriteReview } = require('./review-write-guard');

function isDuplicateOfUrlMismatch(data, sibling) {
  const a = canonicalArticleKey(data.url, { ignoreQuery: true });
  const b = canonicalArticleKey(sibling.url, { ignoreQuery: true });
  return !!(a && b && a !== b
    && !isManuallyProtectedDuplicate(data)
    && !isCrossOutletSyndicationPair(data, sibling, normalizeOutlet)
    && !isRenameCollisionPair(data, sibling));
}

/** Clear an audited mismatch, rechecking manual protection on the current row. */
function clearDuplicateMismatch(filePath, data, mismatch) {
  const field = mismatch.field || 'duplicateOf';
  if (field === 'duplicateOf' && mismatch.reason === 'url-mismatch'
      && isManuallyProtectedDuplicate(data)) return false;

  const reason = mismatch.reason === 'self-reference'
    ? `audit-duplicate-of-url-mismatch.js (--fix) on ${new Date().toISOString().slice(0, 10)}: ${field} pointed at this file itself`
    : mismatch.reason === 'sibling-missing'
      ? `audit-duplicate-of-url-mismatch.js (--fix) on ${new Date().toISOString().slice(0, 10)}: sibling ${mismatch.duplicateOf} no longer exists`
      : `audit-duplicate-of-url-mismatch.js (--fix) on ${new Date().toISOString().slice(0, 10)}: our URL ${data.url} ≠ sibling ${mismatch.duplicateOf} URL ${mismatch.siblingUrl}`;
  data.duplicateClearReason = reason;
  if (field === 'duplicateTextOf') {
    // Let the content-fingerprint pass re-flag a genuine duplicate later.
    delete data.duplicateTextOf;
  } else {
    data.duplicateOf = null;
    data.duplicateReason = null;
  }
  safeWriteReview(filePath, data);
  return true;
}

module.exports = { isDuplicateOfUrlMismatch, clearDuplicateMismatch };
