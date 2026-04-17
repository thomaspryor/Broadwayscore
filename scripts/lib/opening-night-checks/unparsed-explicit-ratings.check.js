'use strict';

const name = 'unparsed-explicit-ratings';
const description = 'Outlets with known rating schemas have reviews with no parsed originalScore';

/**
 * Outlets that publish explicit star/letter ratings and should always have an originalScore.
 * Key: outletId, Value: rating schema description for messages.
 */
const RATING_SCHEMA_OUTLETS = {
  'the-guardian': '5-star',
  'ny-post': '4-star',
  'the-telegraph': '5-star',
  'time-out': '5-star',
  'the-times': '5-star',
  'evening-standard': '5-star',
};

/**
 * @param {Object} show
 * @param {import('./types').CheckContext} context
 * @returns {import('./types').CheckResult}
 */
function run(show, context) {
  const reviews = context.reviewsDoc[show.id] || [];

  const missing = [];
  for (const review of reviews) {
    if (!(review.outletId in RATING_SCHEMA_OUTLETS)) continue;
    // reviews.json uses 'originalRating' (raw string like "3/5 stars"); null means not captured
    if (review.originalRating != null || review.originalScore != null) continue;
    if (review.wrongProduction === true) continue;

    missing.push({
      outletId: review.outletId,
      schema: RATING_SCHEMA_OUTLETS[review.outletId],
      url: review.url,
    });
  }

  if (missing.length === 0) {
    const checked = reviews.filter(r => r.outletId in RATING_SCHEMA_OUTLETS).length;
    return {
      ok: true,
      severity: 'ok',
      message: `All ${checked} known-schema outlet review(s) have parsed originalScore`,
    };
  }

  const messages = missing.map(
    m => `${m.outletId} (${m.schema}) has no parsed rating; queue: node scripts/recover-explicit-ratings.js --show=${show.id} --outlet=${m.outletId}`
  );

  return {
    ok: false,
    severity: 'warning',
    message: messages.join('\n'),
    details: { missing },
  };
}

module.exports = { name, description, run, RATING_SCHEMA_OUTLETS };
