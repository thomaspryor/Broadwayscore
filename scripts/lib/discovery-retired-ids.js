'use strict';

const { loadRetiredIds, RETIRED_IDS_PATH } = require('./retired-show-ids');

// Load once, before discovery fetches or writes anything. The CLI reports
// this expected operational failure as one line instead of a stack trace.
function loadDiscoveryRetiredIds({ listPath = process.env.RETIRED_IDS_PATH || RETIRED_IDS_PATH } = {}) {
  try {
    return loadRetiredIds({ listPath });
  } catch {
    const error = new Error(`Cannot read retired-show-ids registry (${listPath}); refusing discovery until the registry is repaired.`);
    error.code = 'RETIRED_IDS_UNREADABLE';
    throw error;
  }
}

module.exports = { loadDiscoveryRetiredIds };
