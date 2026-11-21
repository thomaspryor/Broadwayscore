'use strict';
/**
 * still-excluded-by.js (BRO-5395): what would keep a review file out of
 * reviews.json once its showNotMentioned flag is cleared. 14 of the 43 rows
 * BRO-5395 cleared by hand stayed out on a second flag (wrongShow from the same
 * missing-title check, a duplicate copy, a stale rejectedAt) that the first
 * sort did not see; audit-multishow-titlecase --rule=flag prints this per row.
 */
const { explainExclusion } = require('./review-guards');

function stillExcludedBy(record, show, filePath) {
  try {
    return explainExclusion({ ...record, showNotMentioned: false }, show, filePath) || null;
  } catch (e) {
    return `error: ${e.message}`;
  }
}

module.exports = { stillExcludedBy };
