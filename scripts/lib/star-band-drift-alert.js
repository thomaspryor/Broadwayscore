'use strict';
/**
 * BRO-7181: worker-card decisions for scripts/audit-star-band-drift.js --alert.
 * Pure. Two conditions, two keys, so a missing input never closes the
 * findings card:
 *   star-band-drift:no-join          no published score joined a review file
 *                                    (reviews.json or the review-texts checkout
 *                                    missing). The out-of-band key is left alone.
 *   star-band-drift:published-out-of-band  published scores outside the critic's
 *                                    own star band or the unanimous model bucket.
 * Rows carry the review-file path, score, scoreSource, kind and the band text
 * from publishedScoreViolation() (numbers only): never review text.
 */
const { buildAuditAlert } = require('./audit-alert');

const NO_JOIN_KEY = 'star-band-drift:no-join';
const OUT_OF_BAND_KEY = 'star-band-drift:published-out-of-band';
const DONE = 'Done when node scripts/audit-star-band-drift.js --strict exits 0.';

/** @param {{publishedJoined:number, publishedOutOfBand:Array<{file,score,source,kind,detail}>}} out */
function decideStarBandAlerts(out) {
  if (!out || !(out.publishedJoined > 0)) {
    return [buildAuditAlert({
      conditionKey: NO_JOIN_KEY,
      rows: ['published scores joined to review files: 0'],
      title: () => 'Star-band audit could not join any published score (input missing)',
      intro: 'The daily star-band audit joined 0 published scores from data/reviews.json to review-text files, so it checked nothing. Either reviews.json was unreadable or the review-texts checkout was missing in data-health-check.yml.',
      hint: `Check the "Checkout review-texts" step and data/reviews.json in the failing run; this is an input problem, not a scoring one. ${DONE}`,
    })];
  }
  const rows = (out.publishedOutOfBand || []).map((r) => `${r.file}: published ${r.score} (${r.source}), ${r.kind}: ${r.detail}`);
  return [
    { action: 'resolve', conditionKey: NO_JOIN_KEY, reason: `joined ${out.publishedJoined} published scores` },
    buildAuditAlert({
      conditionKey: OUT_OF_BAND_KEY,
      rows,
      title: (n) => `Star-band drift: ${n} published score${n === 1 ? '' : 's'} outside the critic's own rating`,
      intro: `The daily star-band audit found ${rows.length} published score${rows.length === 1 ? '' : 's'} outside the band of the critic's printed rating (or all scoring models' bucket), not already queued for rescore.`,
      hint: `For each row read the whole article for the rating (CLAUDE.md section 3: stars are score bands). If the stored rating is wrong, fix it; if the score is wrong, set needsRescore. ${DONE}`,
      resolveReason: 'no published score out of band',
    }),
  ];
}

module.exports = { decideStarBandAlerts, NO_JOIN_KEY, OUT_OF_BAND_KEY };
