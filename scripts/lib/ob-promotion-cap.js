'use strict';

// Match the WE promoter's stability backstop. A surge needs batch review,
// not partial promotion of a potentially bad scrape on successive cron runs.
const MAX_PROMOTE_PER_RUN = 20;

function assertPromotionCap(count) {
  if (count > MAX_PROMOTE_PER_RUN) {
    throw new Error(`Abort: ${count} candidates would be promoted, exceeding MAX_PROMOTE_PER_RUN=${MAX_PROMOTE_PER_RUN}. No shows promoted; candidates remain staged.`);
  }
}

module.exports = { MAX_PROMOTE_PER_RUN, assertPromotionCap };
