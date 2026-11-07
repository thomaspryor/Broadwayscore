'use strict';

const { listingPageUrlReason } = require('./non-review-url-patterns');

// BRO-5693: automatic recovery must not undo an approved URL repair by
// refilling the slot with a section index. An explicitly approved listing
// URL still stands, as do genuine review permalinks and non-URL fixes.
function approvedUrlFixListingReason(record, candidateUrl) {
  const fixes = Array.isArray(record?.approvedFixes) ? record.approvedFixes : [];
  const fix = fixes.filter((entry) => entry.field === 'url').at(-1);
  if (!fix || !candidateUrl || candidateUrl === fix.newValue) return null;
  const reason = listingPageUrlReason(candidateUrl);
  return reason && reason !== 'bare-host' ? reason : null;
}

module.exports = { approvedUrlFixListingReason };
